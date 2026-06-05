/**
 * assistant.js — Corti Clinical Chat Assistant
 *
 * Communication flow:
 *   1. User types → POST /api/chat with { messages, contextId }
 *   2. .NET backend creates/reuses the Corti agent, calls A2A message/stream
 *   3. Backend forwards SSE events: status | text | done | error
 *   4. This file renders them in real-time
 *
 * No framework. Marked.js renders markdown in assistant bubbles.
 */

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE = "http://localhost:5068";

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {{ role: "user"|"assistant", content: string }[]} */
let messages   = [];
let contextId  = null;       // persisted across turns for multi-turn memory
let isLoading  = false;
let abortCtrl  = null;       // AbortController for the current SSE fetch
let totalCredits = 0;

// Thinking timer
let timerInterval = null;
let timerStart    = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messageList    = /** @type {HTMLUListElement} */ (document.getElementById("message-list"));
const emptyState     = document.getElementById("empty-state");
const thinkingBubble = document.getElementById("thinking-bubble");
const thinkingStatus = document.getElementById("thinking-status");
const thinkingTimer  = document.getElementById("thinking-timer");
const chatInput      = /** @type {HTMLTextAreaElement} */ (document.getElementById("chat-input"));
const sendBtn        = document.getElementById("btn-send");
const cancelBtn      = document.getElementById("btn-cancel");
const newChatBtn     = document.getElementById("btn-new-chat");
const creditsTotalEl = document.getElementById("credits-total");

// ── Configure marked ──────────────────────────────────────────────────────────
if (window.marked) {
  window.marked.setOptions({ breaks: true, gfm: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderMarkdown(text) {
  if (!window.marked) return escapeHtml(text).replace(/\n/g, "<br>");
  return window.marked.parse(text);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setLoading(on) {
  isLoading = on;
  sendBtn.disabled = on;
  chatInput.disabled = on;

  if (on) {
    thinkingBubble.classList.remove("hidden");
    // Start timer
    timerStart = Date.now();
    timerInterval = setInterval(() => {
      const secs = Math.round((Date.now() - timerStart) / 1000);
      thinkingTimer.textContent = `· ${secs}s`;
    }, 1000);
  } else {
    thinkingBubble.classList.add("hidden");
    thinkingStatus.textContent = "";
    thinkingTimer.textContent  = "";
    clearInterval(timerInterval);
  }
}

function updateThinkingStatus(msg) {
  if (msg) thinkingStatus.textContent = msg;
}

function scrollToBottom() {
  const wrap = document.querySelector(".messages-wrap");
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function showEmptyState(show) {
  emptyState.style.display = show ? "" : "none";
}

function updateCredits(credits) {
  if (credits == null) return;
  totalCredits += credits;
  creditsTotalEl.textContent = totalCredits.toFixed(4);
}

// ── Render a user message bubble ──────────────────────────────────────────────
function appendUserMessage(text) {
  showEmptyState(false);
  const li = document.createElement("li");
  li.className = "msg user";
  li.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  messageList.appendChild(li);
  scrollToBottom();
  return li;
}

// ── Render an assistant message bubble (streams in) ───────────────────────────
/**
 * Returns an object with methods to:
 *   - addStatus(msg)  → append a status indicator
 *   - appendText(chunk) → stream text into the bubble
 *   - setCredits(n)   → show credits badge
 *   - setError(msg)   → convert bubble to error style
 */
function createAssistantBubble() {
  showEmptyState(false);

  const li = document.createElement("li");
  li.className = "msg assistant";

  const statusList = document.createElement("ul");
  statusList.className = "msg-status-list";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  li.appendChild(statusList);
  li.appendChild(bubble);
  messageList.appendChild(li);

  let rawText = "";

  return {
    addStatus(msg) {
      const item = document.createElement("li");
      item.className = "msg-status-item";
      item.textContent = msg;
      statusList.appendChild(item);
      scrollToBottom();
    },
    appendText(chunk) {
      rawText += chunk;
      bubble.innerHTML = renderMarkdown(rawText);
      scrollToBottom();
    },
    getText() { return rawText; },
    setCredits(n) {
      const badge = document.createElement("div");
      badge.className = "msg-credits mono";
      badge.textContent = `${n.toFixed(4)} credits`;
      li.appendChild(badge);
    },
    setError(msg) {
      li.className = "msg error";
      statusList.remove();
      bubble.innerHTML = escapeHtml(msg);
      scrollToBottom();
    },
    finalise(text) {
      // Re-render the full markdown one last time
      rawText = text || rawText;
      bubble.innerHTML = renderMarkdown(rawText);
      scrollToBottom();
    }
  };
}

// ── Send a message ─────────────────────────────────────────────────────────────
async function sendMessage(text) {
  text = text.trim();
  if (!text || isLoading) return;

  // Add to state + render user bubble
  messages.push({ role: "user", content: text });
  appendUserMessage(text);
  chatInput.value = "";
  autoResizeTextarea();

  setLoading(true);

  const bubble = createAssistantBubble();
  abortCtrl    = new AbortController();
  let assistantText = "";

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ messages, contextId }),
      signal:  abortCtrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      bubble.setError(`Server error (${res.status}): ${errText}`);
      messages.push({ role: "assistant", content: `[Error: ${errText}]` });
      setLoading(false);
      return;
    }

    // ── Read SSE stream ────────────────────────────────────────────────────
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";   // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice("data:".length).trim();
        if (!raw || raw === "[DONE]") continue;

        let event;
        try { event = JSON.parse(raw); } catch { continue; }

        if (event.type === "status") {
          bubble.addStatus(event.message);
          updateThinkingStatus(event.message);

        } else if (event.type === "text") {
          // Once text starts arriving, hide the thinking bubble
          setLoading(false);
          assistantText += event.delta;
          bubble.appendText(event.delta);

        } else if (event.type === "done") {
          if (event.contextId) contextId = event.contextId;
          if (event.credits != null) {
            bubble.setCredits(event.credits);
            updateCredits(event.credits);
          }
          bubble.finalise(assistantText);
          setLoading(false);
          break;

        } else if (event.type === "error") {
          bubble.setError(event.message);
          setLoading(false);
          break;
        }
      }
    }

    // Make sure loading is off
    setLoading(false);

    // Store assistant reply
    if (assistantText) {
      messages.push({ role: "assistant", content: assistantText });
    }

  } catch (err) {
    if (err.name === "AbortError") {
      // User cancelled
      if (!assistantText) {
        bubble.setError("Request cancelled.");
      } else {
        bubble.finalise(assistantText);
        if (assistantText) messages.push({ role: "assistant", content: assistantText });
      }
    } else {
      bubble.setError(`Connection error: ${err.message}`);
    }
    setLoading(false);
  }
}

// ── Cancel in-flight request ─────────────────────────────────────────────────
function cancelRequest() {
  if (abortCtrl) {
    abortCtrl.abort();
    abortCtrl = null;
  }
  setLoading(false);
}

// ── New chat ──────────────────────────────────────────────────────────────────
function newChat() {
  cancelRequest();
  messages  = [];
  contextId = null;

  // Clear rendered messages (keep empty state li)
  const items = messageList.querySelectorAll("li.msg");
  items.forEach(li => li.remove());
  showEmptyState(true);

  chatInput.value = "";
  autoResizeTextarea();
  chatInput.focus();
}

// ── Auto-resize textarea ──────────────────────────────────────────────────────
function autoResizeTextarea() {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
}

// ── Nav link to dictation page ───────────────────────────────────────────────
const nav = document.createElement("a");
nav.href      = "/";
nav.className = "page-nav";
nav.textContent = "← Dictation";
document.body.appendChild(nav);

// ── Event listeners ───────────────────────────────────────────────────────────

// Send on button click
sendBtn.addEventListener("click", () => sendMessage(chatInput.value));

// Send on Enter (Shift+Enter = newline)
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

// Auto-resize
chatInput.addEventListener("input", autoResizeTextarea);

// Cancel
cancelBtn.addEventListener("click", cancelRequest);

// New chat
newChatBtn.addEventListener("click", newChat);

// Seed prompt buttons
messageList.addEventListener("click", (e) => {
  const btn = e.target.closest(".seed-btn");
  if (!btn) return;
  const prompt = btn.dataset.prompt;
  if (prompt) {
    chatInput.value = prompt;
    autoResizeTextarea();
    chatInput.focus();
  }
});

// Initial focus
chatInput.focus();

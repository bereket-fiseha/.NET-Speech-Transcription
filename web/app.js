/**
 * app.js — Medical Dictation
 *
 * Two live-dictation providers:
 *
 * Corti     — <corti-dictation> web component via CDN WebSocket
 * AssemblyAI — Direct browser WebSocket to wss://streaming.assemblyai.com
 *              Model: Universal-3 Pro (u3-rt-pro)
 *
 * ── AssemblyAI billing ────────────────────────────────────────────────────────
 * Billing = session WALL-CLOCK duration (not audio sent). Sessions left open
 * for 3 h are billed for 3 h. Every path that could orphan the socket:
 *
 *  Event                    Mitigation
 *  ─────────────────────── ────────────────────────────────────────────────────
 *  Stop button              sendTerminate() → await server Termination → close
 *  Provider switch          stopAssemblyAI() — same flow as stop button
 *  Page close / refresh     pagehide: sendTerminate() + ws.close() synchronous
 *  Tab hidden > 30 s        visibilitychange auto-stop timer
 *  WS error                 sendTerminate() before cleanup
 *  Server-side close        onclose — audio already gone, just tidy up UI
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE    = "http://localhost:5068";
const AAI_WS_BASE = "wss://streaming.assemblyai.com/v3/ws";
const AAI_SAMPLE_RATE          = 16000;
const AAI_HIDDEN_AUTOSTOP_SECS = 30;  // stop session if tab is hidden this long

// ── SOAP sections ─────────────────────────────────────────────────────────────
const SECTIONS = ["subjective", "objective", "assessment", "plan"];

// ── State ─────────────────────────────────────────────────────────────────────
let activeIndex    = 0;
let sessionActive  = false;
let creditsValue   = null;
/** @type {"corti"|"assemblyai"} */
let activeProvider = "corti";

// AssemblyAI
/** @type {WebSocket|null} */                    let aaiWs        = null;
/** @type {AudioContext|null} */                 let aaiAudioCtx  = null;
/** @type {MediaStream|null} */                  let aaiStream    = null;
/** @type {ScriptProcessorNode|null} */          let aaiProcessor = null;
/** @type {MediaStreamAudioSourceNode|null} */   let aaiSource    = null;
let aaiRecording   = false;
let aaiVizHandle   = null;
let aaiHiddenTimer = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const dictationEl         = $("dictation");
const activeSectionEl     = $("active-section-name");
const creditsEl           = $("credits-value");
const creditsLabelEl      = $("credits-label");
const statusDot           = $("status-dot");
const errorBanner         = $("error-banner");
const errorText           = $("error-text");
const commandOutput       = $("command-output");
const cortiWidget         = $("corti-widget");
const aaiWidget           = $("assemblyai-widget");
const aaiBtn              = $("aai-btn");
const aaiBtnLabel         = $("aai-btn-label");
const aaiViz              = $("aai-viz");
const aaiErrorEl          = $("aai-error");
const aaiErrorText        = $("aai-error-text");
const cortiCommands       = $("corti-commands");
const providerBannerTitle = $("provider-banner-title");
const providerBannerSub   = $("provider-banner-sub");
const providerIcon        = $("provider-icon");

const getTextarea  = (i) => $(`ta-${SECTIONS[i]}`);
const getInterimEl = (i) => $(`interim-${SECTIONS[i]}`);
const getSectionEl = (i) => $(`section-${SECTIONS[i]}`);

// ── Provider switching ────────────────────────────────────────────────────────

function switchProvider(provider) {
  if (provider === activeProvider) return;

  if (activeProvider === "corti") {
    dictationEl.closeConnection?.();
  } else {
    stopAssemblyAI();
  }

  activeProvider = provider;

  // Keep the dropdown in sync (in case switchProvider is called programmatically)
  const sel = document.getElementById("model-select");
  if (sel && sel.value !== provider) sel.value = provider;

  // Show/hide widgets — use direct style to be unambiguous
  cortiWidget.style.display   = provider === "corti"       ? "" : "none";
  aaiWidget.style.display     = provider === "assemblyai"  ? "" : "none";
  cortiCommands.style.display = provider === "corti"       ? "" : "none";

  if (provider === "corti") {
    providerIcon.textContent        = "🎙️";
    providerBannerTitle.textContent = "Corti AI";
    providerBannerSub.textContent   = "Medical-grade STT · WebSocket";
    creditsLabelEl.textContent      = "Credits";
  } else {
    providerIcon.textContent        = "🔵";
    providerBannerTitle.textContent = "AssemblyAI";
    providerBannerSub.textContent   = "Universal-3 Pro · u3-rt-pro";
    creditsLabelEl.textContent      = "Session";
  }

  creditsValue  = null;
  sessionActive = false;
  updateCreditsDisplay();
  clearAllInterim();
  setStatus("disconnected");
  if (provider === "corti") initCorti();
}

document.getElementById("model-select").addEventListener("change", (e) => {
  switchProvider(e.target.value);
});

// ── Section management ────────────────────────────────────────────────────────

function activateSection(index) {
  index = Math.max(0, Math.min(index, SECTIONS.length - 1));
  getSectionEl(activeIndex).classList.remove("is-active");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active-btn"));
  activeIndex = index;
  getSectionEl(activeIndex).classList.add("is-active");
  document.querySelectorAll(".nav-btn")[activeIndex]?.classList.add("active-btn");
  activeSectionEl.textContent =
    SECTIONS[activeIndex].charAt(0).toUpperCase() + SECTIONS[activeIndex].slice(1);
  getTextarea(activeIndex).focus();
}

// ── Transcript helpers ────────────────────────────────────────────────────────

function appendFinalText(text) {
  const ta = getTextarea(activeIndex);
  const v  = ta.value.trimEnd();
  ta.value = v ? `${v} ${text}` : text;
}

function showInterim(text) { getInterimEl(activeIndex).textContent = text; }

function clearAllInterim() {
  SECTIONS.forEach((_, i) => { getInterimEl(i).textContent = ""; });
}

// ── Delete helpers ────────────────────────────────────────────────────────────

function deleteLastSentence(text) {
  const parts = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  if (parts.length <= 1) return "";
  parts.pop();
  return parts.join(" ") + " ";
}

function deleteLastWord(text) {
  const t = text.trimEnd();
  const i = t.lastIndexOf(" ");
  return i === -1 ? "" : t.slice(0, i) + " ";
}

// ── Credits display ───────────────────────────────────────────────────────────

function updateCreditsDisplay() {
  if (activeProvider === "corti") {
    creditsEl.textContent =
      creditsValue !== null ? creditsValue.toFixed(4) :
      sessionActive         ? "pending…" : "—";
  } else {
    creditsEl.textContent =
      creditsValue !== null ? `${creditsValue}s` :
      sessionActive         ? "live" : "—";
  }
}

// ── Status dot ────────────────────────────────────────────────────────────────

function setStatus(state) {
  statusDot.className = "status-dot";
  if (state === "connected")  statusDot.classList.add("connected");
  if (state === "connecting") statusDot.classList.add("connecting");
  if (state === "error")      statusDot.classList.add("error");
  statusDot.title = state.charAt(0).toUpperCase() + state.slice(1);
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function showCortiError(msg) {
  errorText.textContent = msg;
  errorBanner.classList.remove("hidden");
  setStatus("error");
  console.error("[Corti]", msg);
}
function clearCortiError() {
  errorBanner.classList.add("hidden");
  errorText.textContent = "";
}
function showAaiError(msg) {
  aaiErrorText.textContent = msg;
  aaiErrorEl.classList.remove("hidden");
  setStatus("error");
  console.error("[AssemblyAI]", msg);
}
function clearAaiError() {
  aaiErrorEl.classList.add("hidden");
  aaiErrorText.textContent = "";
}

// ── Command feedback ──────────────────────────────────────────────────────────

let _cmdTimer = null;
function showCommandFeedback(msg) {
  commandOutput.textContent = msg;
  commandOutput.classList.remove("hidden");
  clearTimeout(_cmdTimer);
  _cmdTimer = setTimeout(() => commandOutput.classList.add("hidden"), 3000);
}

// ═════════════════════════════════════════════════════════════════════════════
// CORTI
// ═════════════════════════════════════════════════════════════════════════════

async function fetchCortiToken() {
  const res = await fetch(`${API_BASE}/api/token`, { method: "POST" });
  if (!res.ok) { const b = await res.text(); throw new Error(`(${res.status}) ${b}`); }
  return res.json();
}

/**
 * initCorti — only handles auth + dictationConfig.
 * Event listeners are registered ONCE below (outside this function) so that
 * switching providers and back never stacks duplicate handlers.
 */
async function initCorti() {
  setStatus("connecting");
  let tokenData;
  try { tokenData = await fetchCortiToken(); }
  catch (err) {
    showCortiError(`Token failed: ${err.message}`);
    return;
  }
  clearCortiError();

  dictationEl.authConfig = {
    accessToken:        tokenData.accessToken,
    expiresIn:          tokenData.expiresIn,
    refreshAccessToken: async () => {
      const f = await fetchCortiToken();
      return { accessToken: f.accessToken, expiresIn: f.expiresIn };
    },
  };

  dictationEl.dictationConfig = {
    primaryLanguage:      "en",
    automaticPunctuation: true,
    spokenPunctuation:    false,
    numbers:              "numerals_above_nine",
    measurements:         "abbreviated",
    commands: [
      {
        id: "go_to_section",
        phrases: ["go to {section} section", "switch to {section} section"],
        variables: [{ key: "section", type: "enum",
          enum: ["subjective", "objective", "assessment", "plan", "next", "previous"] }],
      },
      {
        id: "delete_range",
        phrases: ["delete {range}"],
        variables: [{ key: "range", type: "enum", enum: ["the last sentence", "that"] }],
      },
      { id: "clear_section", phrases: ["clear section"] },
    ],
  };

  setStatus("connected");
}

// ── Corti event listeners — registered ONCE, never inside initCorti() ─────────

dictationEl.addEventListener("transcript", (e) => {
  if (activeProvider !== "corti") return;
  const { text, isFinal, rawTranscriptText } = e.detail.data;
  if (isFinal) {
    clearAllInterim();
    appendFinalText(text);
    if (!sessionActive) { sessionActive = true; updateCreditsDisplay(); }
  } else {
    showInterim(rawTranscriptText ?? text);
  }
});

dictationEl.addEventListener("command", (e) => {
  if (activeProvider !== "corti") return;
  const { id, variables } = e.detail.data;
  clearAllInterim();
  if (id === "go_to_section") {
    const s = (variables?.section ?? "").toLowerCase();
    if (s === "next")          { activateSection(activeIndex + 1); showCommandFeedback(`→ ${SECTIONS[activeIndex]}`); }
    else if (s === "previous") { activateSection(activeIndex - 1); showCommandFeedback(`← ${SECTIONS[activeIndex]}`); }
    else { const i = SECTIONS.indexOf(s); if (i !== -1) { activateSection(i); showCommandFeedback(`→ ${SECTIONS[i]}`); } }
    return;
  }
  if (id === "delete_range") {
    const range = (variables?.range ?? "").toLowerCase();
    const ta = getTextarea(activeIndex);
    if (range === "the last sentence") { ta.value = deleteLastSentence(ta.value); showCommandFeedback("Deleted last sentence"); }
    else if (range === "that") {
      const s = ta.selectionStart ?? 0, e2 = ta.selectionEnd ?? 0;
      if (s !== e2) { ta.value = ta.value.slice(0, s) + ta.value.slice(e2); showCommandFeedback("Deleted selection"); }
      else { ta.value = deleteLastWord(ta.value); showCommandFeedback("Deleted last word"); }
    }
    return;
  }
  if (id === "clear_section") { getTextarea(activeIndex).value = ""; showCommandFeedback(`Cleared ${SECTIONS[activeIndex]}`); }
});

dictationEl.addEventListener("usage", (e) => {
  if (activeProvider !== "corti") return;
  creditsValue  = e.detail?.credits ?? creditsValue;
  sessionActive = false;
  updateCreditsDisplay();
});

dictationEl.addEventListener("delta-usage", (e) => {
  if (activeProvider !== "corti") return;
  creditsValue = e.detail?.credits ?? creditsValue;
  updateCreditsDisplay();
});

dictationEl.addEventListener("ready", () => {
  if (activeProvider !== "corti") return;
  setStatus("connected");
  clearCortiError();
});

dictationEl.addEventListener("error", (e) => {
  if (activeProvider !== "corti") return;
  showCortiError(String(e.detail?.message ?? e.detail ?? "Unknown error"));
});

window.addEventListener("beforeunload", () => dictationEl.closeConnection?.());

// ═════════════════════════════════════════════════════════════════════════════
// ASSEMBLYAI
// ═════════════════════════════════════════════════════════════════════════════

async function fetchAaiToken() {
  const res = await fetch(`${API_BASE}/api/assemblyai-token`);
  if (!res.ok) { const b = await res.text(); throw new Error(`(${res.status}) ${b}`); }
  const d = await res.json();
  if (!d.token) throw new Error("No token in response");
  return d.token;
}

// ── Audio helpers ─────────────────────────────────────────────────────────────

function float32ToInt16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const s = Math.max(-1, Math.min(1, buf[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function resampleBuffer(buf, inRate, outRate) {
  if (inRate === outRate) return buf;
  const ratio = inRate / outRate;
  const len   = Math.round(buf.length / ratio);
  const out   = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = buf[Math.min(Math.round(i * ratio), buf.length - 1)];
  }
  return out;
}

function updateViz(analyser, dataArray) {
  if (!aaiRecording) return;
  analyser.getByteFrequencyData(dataArray);
  const bars = aaiViz.querySelectorAll("span");
  const step = Math.floor(dataArray.length / bars.length);
  bars.forEach((bar, i) => {
    bar.style.height = `${Math.max(3, (dataArray[i * step] / 255) * 24)}px`;
  });
  aaiVizHandle = requestAnimationFrame(() => updateViz(analyser, dataArray));
}

// ── Session termination (billing-critical) ────────────────────────────────────

/**
 * Send a Terminate JSON message on the WebSocket.
 * Safe to call even if the socket is not OPEN — fails silently.
 */
function sendTerminate(ws) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: "Terminate" })); } catch { /* ignore */ }
  }
}

/**
 * Fully stop the AssemblyAI session:
 *   1. Stop audio pipeline (no more PCM sent)
 *   2. Send Terminate to server
 *   3. Wait up to 3 s for server to send Termination + close the socket
 *   4. Force-close if server doesn't respond in time
 *
 * Returns a Promise — safe to await when you need to know it's done.
 * Idempotent: calling when already stopped is a no-op.
 */
function stopAssemblyAI() {
  clearTimeout(aaiHiddenTimer);
  aaiHiddenTimer = null;

  if (!aaiWs && !aaiRecording) return Promise.resolve();

  // Step 1: stop audio immediately — no more binary frames
  cleanupAaiAudio();

  return new Promise((resolve) => {
    const ws = aaiWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (ws) { try { ws.close(1000, "Stopped"); } catch { } }
      aaiWs = null;
      resolve();
      return;
    }

    // Step 2: request graceful session close
    sendTerminate(ws);

    // Step 3: give server 3 s to reply with Termination and close the socket
    const forceCloseTimer = setTimeout(() => {
      console.warn("[AssemblyAI] No Termination reply within 3 s — force-closing");
      try { ws.close(1000, "Force closed"); } catch { }
      aaiWs = null;
      resolve();
    }, 3000);

    // Server closes socket after sending Termination
    const origOnClose = ws.onclose;
    ws.onclose = (ev) => {
      clearTimeout(forceCloseTimer);
      if (typeof origOnClose === "function") origOnClose.call(ws, ev);
      aaiWs = null;
      resolve();
    };
  }).finally(() => {
    setAaiBtnIdle();
    setStatus("disconnected");
  });
}

function cleanupAaiAudio() {
  aaiRecording = false;
  clearTimeout(aaiHiddenTimer);
  aaiHiddenTimer = null;
  cancelAnimationFrame(aaiVizHandle);
  aaiViz.classList.remove("active");
  aaiViz.querySelectorAll("span").forEach(b => { b.style.height = "3px"; });
  if (aaiProcessor) { try { aaiProcessor.disconnect(); } catch { } aaiProcessor = null; }
  if (aaiSource)    { try { aaiSource.disconnect();    } catch { } aaiSource    = null; }
  if (aaiAudioCtx && aaiAudioCtx.state !== "closed") {
    aaiAudioCtx.close().catch(() => {});
    aaiAudioCtx = null;
  }
  if (aaiStream) { aaiStream.getTracks().forEach(t => t.stop()); aaiStream = null; }
}

function setAaiBtnIdle() {
  aaiBtn.classList.remove("recording");
  aaiBtnLabel.textContent = "Start dictation";
  aaiBtn.disabled = false;
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function startAssemblyAI() {
  clearAaiError();
  setStatus("connecting");
  aaiBtn.disabled = true;

  let token;
  try { token = await fetchAaiToken(); }
  catch (err) { showAaiError(`Token failed: ${err.message}`); aaiBtn.disabled = false; setStatus("error"); return; }

  try { aaiStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
  catch (err) { showAaiError(`Microphone denied: ${err.message}`); aaiBtn.disabled = false; setStatus("error"); return; }

  const params = new URLSearchParams({
    speech_model: "u3-rt-pro",
    sample_rate:  String(AAI_SAMPLE_RATE),
    format_turns: "true",
    token,
  });

  aaiWs = new WebSocket(`${AAI_WS_BASE}?${params}`);
  aaiWs.binaryType = "arraybuffer";

  aaiWs.onopen = () => {
    setStatus("connected");
    aaiRecording  = true;
    sessionActive = true;
    updateCreditsDisplay();
    aaiBtn.classList.add("recording");
    aaiBtnLabel.textContent = "Stop dictation";
    aaiBtn.disabled = false;
    aaiViz.classList.add("active");

    aaiAudioCtx = new AudioContext({ sampleRate: AAI_SAMPLE_RATE });
    aaiSource   = aaiAudioCtx.createMediaStreamSource(aaiStream);

    const analyser  = aaiAudioCtx.createAnalyser();
    analyser.fftSize = 64;
    const dataArr   = new Uint8Array(analyser.frequencyBinCount);
    aaiSource.connect(analyser);
    aaiVizHandle = requestAnimationFrame(() => updateViz(analyser, dataArr));

    const ctxRate = aaiAudioCtx.sampleRate;
    aaiProcessor  = aaiAudioCtx.createScriptProcessor(4096, 1, 1);
    aaiSource.connect(aaiProcessor);
    aaiProcessor.connect(aaiAudioCtx.destination);

    aaiProcessor.onaudioprocess = (ev) => {
      if (!aaiRecording || !aaiWs || aaiWs.readyState !== WebSocket.OPEN) return;
      const raw = ev.inputBuffer.getChannelData(0);
      const pcm = float32ToInt16(resampleBuffer(raw, ctxRate, AAI_SAMPLE_RATE));
      aaiWs.send(pcm.buffer);
    };
  };

  aaiWs.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "Begin") {
      console.info("[AssemblyAI] Session:", msg.id);

    } else if (msg.type === "Turn") {
      const transcript = msg.transcript ?? "";
      if (msg.end_of_turn === true) {
        clearAllInterim();
        if (transcript.trim()) appendFinalText(transcript);
      } else {
        if (transcript.trim()) showInterim(transcript);
      }

    } else if (msg.type === "Termination") {
      // Server confirmed session is closed — this is the billing-end signal
      const secs = msg.session_duration_seconds ?? 0;
      creditsValue  = secs;
      sessionActive = false;
      updateCreditsDisplay();
      showCommandFeedback(`Session closed · ${secs}s billed`);
      console.info("[AssemblyAI] Terminated, billed duration:", secs + "s");
    }
  };

  aaiWs.onerror = (ev) => {
    console.error("[AssemblyAI] WS error", ev);
    // Send Terminate before cleanup — the socket may still be OPEN on the server.
    // Without this the server holds the session open until its own timeout.
    sendTerminate(aaiWs);
    showAaiError("WebSocket error — check API key and network.");
    setTimeout(() => {
      cleanupAaiAudio();
      if (aaiWs) { try { aaiWs.close(); } catch { } aaiWs = null; }
      setAaiBtnIdle();
      setStatus("error");
    }, 2000);
  };

  aaiWs.onclose = (ev) => {
    console.info("[AssemblyAI] Closed", ev.code, ev.reason);
    // Socket is already gone — just clean up our side
    cleanupAaiAudio();
    setAaiBtnIdle();
    if (!ev.wasClean && ev.code !== 1000 && ev.code !== 1005) {
      showAaiError(`Disconnected (${ev.code}): ${ev.reason || "unexpected"}`);
      setStatus("error");
    } else {
      setStatus("disconnected");
    }
  };
}

aaiBtn.addEventListener("click", () => {
  if (aaiRecording) stopAssemblyAI();
  else              startAssemblyAI();
});

// ── Billing-safe page lifecycle ───────────────────────────────────────────────

/**
 * pagehide fires reliably on tab close, navigate-away, and page refresh —
 * unlike beforeunload which is suppressed in many browsers.
 *
 * We can't await Promises here; the page is tearing down. We do the tightest
 * synchronous approximation:
 *   1. Stop audio (no more PCM frames in flight)
 *   2. Send Terminate over the still-open socket
 *   3. Close the socket from our end (sends a FIN; server sees client disconnect
 *      and closes the session — this is NOT the 3-hour runaway scenario)
 *
 * If the page dies before the server's Termination reply reaches us, we lose
 * the duration echo — but the session IS closed. The few milliseconds of
 * round-trip are negligible compared to accidental 3-hour sessions.
 */
function handlePageHide() {
  if (activeProvider === "assemblyai" && aaiWs) {
    cleanupAaiAudio();                     // stop mic immediately
    sendTerminate(aaiWs);                  // tell server to close the session
    try { aaiWs.close(1000, "Page unload"); } catch { }
    aaiWs = null;
  }
  if (activeProvider === "corti") {
    dictationEl.closeConnection?.();
  }
}

/**
 * Auto-stop when the tab goes hidden for more than AAI_HIDDEN_AUTOSTOP_SECS.
 * Prevents silent billing accumulation while the user has the tab in the
 * background (e.g. switched to another app).
 */
function handleVisibilityChange() {
  if (document.hidden) {
    if (activeProvider === "assemblyai" && aaiRecording) {
      aaiHiddenTimer = setTimeout(() => {
        console.warn(`[AssemblyAI] Tab hidden ${AAI_HIDDEN_AUTOSTOP_SECS}s — auto-stopping session`);
        stopAssemblyAI();
      }, AAI_HIDDEN_AUTOSTOP_SECS * 1000);
    }
  } else {
    // Tab visible again
    clearTimeout(aaiHiddenTimer);
    aaiHiddenTimer = null;
    // If auto-stop fired, let user know
    if (activeProvider === "assemblyai" && !aaiRecording && creditsValue !== null) {
      showAaiError(
        `Session stopped after ${AAI_HIDDEN_AUTOSTOP_SECS}s in background to prevent billing. ` +
        "Click Start to begin a new session."
      );
    }
  }
}

window.addEventListener("pagehide",        handlePageHide);
document.addEventListener("visibilitychange", handleVisibilityChange);

// ── Shared UI ─────────────────────────────────────────────────────────────────

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => activateSection(parseInt(btn.dataset.index ?? "0", 10)));
});

SECTIONS.forEach((_, i) => {
  getSectionEl(i).addEventListener("click", () => activateSection(i));
  getTextarea(i).addEventListener("focus",  () => activateSection(i));
});

$("btn-copy")?.addEventListener("click", async () => {
  const note = SECTIONS.map(s => {
    const ta = $(`ta-${s}`);
    return `${s.charAt(0).toUpperCase() + s.slice(1)}:\n${ta.value.trim()}`;
  }).join("\n\n");
  try { await navigator.clipboard.writeText(note); showCommandFeedback("Note copied"); }
  catch { showCommandFeedback("Copy failed — select manually"); }
});

$("btn-clear-all")?.addEventListener("click", () => {
  if (!confirm("Clear all four sections?")) return;
  SECTIONS.forEach((_, i) => { getTextarea(i).value = ""; getInterimEl(i).textContent = ""; });
  showCommandFeedback("All sections cleared");
});

// ── Boot ──────────────────────────────────────────────────────────────────────
// Set explicit initial display so style.display toggling in switchProvider
// works regardless of CSS class specificity battles.
cortiWidget.style.display   = "";      // visible — Corti is default
aaiWidget.style.display     = "none";  // hidden
cortiCommands.style.display = "";      // visible

activateSection(0);
updateCreditsDisplay();
initCorti();

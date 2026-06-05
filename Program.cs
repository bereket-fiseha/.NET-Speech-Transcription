using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);

// ── Services ──────────────────────────────────────────────────────────────────
builder.Services.AddOpenApi();
builder.Services.AddHttpClient();

builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
        policy.WithOrigins(
                "http://localhost:5068",
                "https://localhost:7170",
                "http://localhost:5173",
                "http://localhost:3000",
                "http://localhost:8080",
                "http://127.0.0.1:5500",
                "null"
            )
            .AllowAnyHeader()
            .AllowAnyMethod());
});

// ── Configuration ──────────────────────────────────────────────────────────────
var tenantName   = builder.Configuration["Corti:TenantName"]   ?? "";
var clientId     = builder.Configuration["Corti:ClientId"]     ?? "";
var clientSecret = builder.Configuration["Corti:ClientSecret"] ?? "";
var environment  = builder.Configuration["Corti:Environment"]  ?? "eu";

// ── Agent singleton: created lazily on first chat request ──────────────────────
AgentSingleton? agentSingleton = null;
var agentLock = new SemaphoreSlim(1, 1);

var app = builder.Build();

// ── Pipeline ──────────────────────────────────────────────────────────────────
if (app.Environment.IsDevelopment())
    app.MapOpenApi();

app.UseHttpsRedirection();
app.UseCors("Frontend");

var webRoot = Path.Combine(AppContext.BaseDirectory, "web");
if (!Directory.Exists(webRoot))
    webRoot = Path.Combine(builder.Environment.ContentRootPath, "web");

if (Directory.Exists(webRoot))
{
    var fileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(webRoot);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider, RequestPath = "" });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = fileProvider, RequestPath = "" });
}

// ── POST /api/token ────────────────────────────────────────────────────────────
app.MapPost("/api/token", async (
    [FromServices] IConfiguration config,
    [FromServices] IHttpClientFactory httpClientFactory,
    [FromServices] ILogger<Program> logger) =>
{
    var tn  = config["Corti:TenantName"];
    var cid = config["Corti:ClientId"];
    var cs  = config["Corti:ClientSecret"];
    var env = config["Corti:Environment"] ?? "eu";

    if (string.IsNullOrWhiteSpace(tn) || string.IsNullOrWhiteSpace(cid) || string.IsNullOrWhiteSpace(cs))
        return Results.Problem("Corti credentials not configured.", statusCode: 500);

    var host     = env.Equals("us", StringComparison.OrdinalIgnoreCase) ? "auth.us.corti.app" : "auth.eu.corti.app";
    var tokenUrl = $"https://{host}/realms/{tn}/protocol/openid-connect/token";

    var form = new Dictionary<string, string>
    {
        ["grant_type"] = "client_credentials",
        ["client_id"]  = cid,
        ["client_secret"] = cs,
        ["scope"] = "openid transcribe",
    };

    try
    {
        var http = httpClientFactory.CreateClient();
        var res  = await http.PostAsync(tokenUrl, new FormUrlEncodedContent(form));
        if (!res.IsSuccessStatusCode)
        {
            var err = await res.Content.ReadAsStringAsync();
            logger.LogError("Corti auth {Status}: {Body}", res.StatusCode, err);
            return Results.Problem(err, statusCode: (int)res.StatusCode);
        }
        var json = await res.Content.ReadFromJsonAsync<CortiTokenResponse>();
        if (json is null) return Results.Problem("Empty auth response.", statusCode: 502);
        return Results.Ok(new { accessToken = json.AccessToken, expiresIn = json.ExpiresIn });
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Token request failed");
        return Results.Problem(ex.Message, statusCode: 502);
    }
})
.WithName("GetCortiToken")
.WithTags("Auth");

// ── GET /api/assemblyai-token ──────────────────────────────────────────────────
// Issues a short-lived AssemblyAI temporary token so the browser can open a
// WebSocket directly to wss://streaming.assemblyai.com without ever seeing
// the real API key.
// Token is valid for 60 s (one-time use, one session).
app.MapGet("/api/assemblyai-token", async (
    [FromServices] IConfiguration config,
    [FromServices] IHttpClientFactory httpClientFactory,
    [FromServices] ILogger<Program> logger) =>
{
    var apiKey = config["AssemblyAI:ApiKey"];
    if (string.IsNullOrWhiteSpace(apiKey))
        return Results.Problem(
            title: "AssemblyAI API key not configured",
            detail: "Set AssemblyAI:ApiKey in appsettings.Development.json.",
            statusCode: 500);

    try
    {
        var http = httpClientFactory.CreateClient();
        using var req = new HttpRequestMessage(
            HttpMethod.Get,
            "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60");
        req.Headers.Add("Authorization", apiKey);

        var res = await http.SendAsync(req);
        if (!res.IsSuccessStatusCode)
        {
            var err = await res.Content.ReadAsStringAsync();
            logger.LogError("AssemblyAI token error {Status}: {Body}", res.StatusCode, err);
            return Results.Problem(err, statusCode: (int)res.StatusCode);
        }

        var json = await res.Content.ReadFromJsonAsync<AssemblyAiTokenResponse>();
        if (json?.Token is null)
            return Results.Problem("Empty token response from AssemblyAI.", statusCode: 502);

        return Results.Ok(new { token = json.Token });
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "AssemblyAI token request failed");
        return Results.Problem(ex.Message, statusCode: 502);
    }
})
.WithName("GetAssemblyAIToken")
.WithTags("Auth");


// Body: { "messages": [...], "contextId": "..." }
// Each SSE event is one of:
//   data: {"type":"status","message":"calling pubmed-expert"}
//   data: {"type":"text","delta":"..."}
//   data: {"type":"done","credits":0.0034}
//   data: {"type":"error","message":"..."}
app.MapPost("/api/chat", async (
    HttpContext http,
    [FromServices] IConfiguration config,
    [FromServices] IHttpClientFactory httpClientFactory,
    [FromServices] ILogger<Program> logger,
    CancellationToken ct) =>
{
    // ── Read request body ────────────────────────────────────────────────────
    ChatRequest? body;
    try { body = await http.Request.ReadFromJsonAsync<ChatRequest>(ct); }
    catch { http.Response.StatusCode = 400; await http.Response.WriteAsync("Bad request body"); return; }

    if (body is null || body.Messages.Count == 0)
    {
        http.Response.StatusCode = 400;
        await http.Response.WriteAsync("messages array is required");
        return;
    }

    // ── Validate credentials ─────────────────────────────────────────────────
    var tn  = config["Corti:TenantName"];
    var cid = config["Corti:ClientId"];
    var cs  = config["Corti:ClientSecret"];
    var env = config["Corti:Environment"] ?? "eu";

    if (string.IsNullOrWhiteSpace(tn) || string.IsNullOrWhiteSpace(cid) || string.IsNullOrWhiteSpace(cs))
    {
        http.Response.StatusCode = 500;
        await http.Response.WriteAsync("Corti credentials not configured.");
        return;
    }

    // ── Set up SSE headers ───────────────────────────────────────────────────
    http.Response.ContentType = "text/event-stream";
    http.Response.Headers["Cache-Control"] = "no-cache";
    http.Response.Headers["X-Accel-Buffering"] = "no";

    async Task SendSseAsync(object payload)
    {
        var json = JsonSerializer.Serialize(payload, SseJsonOptions.Default);
        await http.Response.WriteAsync($"data: {json}\n\n", ct);
        await http.Response.Body.FlushAsync(ct);
    }

    // ── Ensure the Corti agent exists (lazy singleton) ───────────────────────
    if (agentSingleton is null)
    {
        await agentLock.WaitAsync(ct);
        try
        {
            if (agentSingleton is null)
            {
                await SendSseAsync(new { type = "status", message = "Initialising clinical assistant…" });

                // Derive API base + auth token for the raw agent creation call
                var apiHost  = env.Equals("us", StringComparison.OrdinalIgnoreCase) ? "api.us.corti.app" : "api.eu.corti.app";
                var authHost = env.Equals("us", StringComparison.OrdinalIgnoreCase) ? "auth.us.corti.app" : "auth.eu.corti.app";

                // Get a fresh token for the agent creation HTTP call
                var initHttp = httpClientFactory.CreateClient();
                var initTokenRes = await initHttp.PostAsync(
                    $"https://{authHost}/realms/{tn}/protocol/openid-connect/token",
                    new FormUrlEncodedContent(new Dictionary<string, string>
                    {
                        ["grant_type"]    = "client_credentials",
                        ["client_id"]     = cid,
                        ["client_secret"] = cs,
                        ["scope"]         = "openid",
                    }));
                initTokenRes.EnsureSuccessStatusCode();
                var initToken = (await initTokenRes.Content.ReadFromJsonAsync<CortiTokenResponse>())!.AccessToken;

                // Create the agent via raw HTTP (avoids SDK class-name uncertainty)
                var createPayload = new
                {
                    name        = "Corti Medical Assistant",
                    description = "Multi-expert clinical chat assistant",
                    systemPrompt = "You are the Corti Medical Assistant, helping a doctor with day-to-day clinical questions. You have access to specialised experts: pubmed-expert (biomedical literature), coding-expert (ICD-10/CPT codes), and clinical-trials-expert (clinical trials registry). Choose the right expert(s) for each question and synthesise a concise evidence-backed answer. Always cite sources (PubMed PMID, NCT trial ID, etc.). Never give treatment advice — support clinician judgment. Be concise.",
                    experts = new object[]
                    {
                        new { type = "reference", name = "pubmed-expert" },
                        new { type = "reference", name = "coding-expert" },
                        new { type = "reference", name = "clinical-trials-expert" },
                    }
                };

                using var createReq = new HttpRequestMessage(HttpMethod.Post, $"https://{apiHost}/agents?ephemeral=true");
                createReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", initToken);
                createReq.Headers.Add("Tenant-Name", tn);
                createReq.Content = new StringContent(JsonSerializer.Serialize(createPayload), Encoding.UTF8, "application/json");

                var createRes = await initHttp.SendAsync(createReq);
                if (!createRes.IsSuccessStatusCode)
                {
                    var errBody = await createRes.Content.ReadAsStringAsync();
                    throw new Exception($"Agent creation failed ({createRes.StatusCode}): {errBody}");
                }

                var agentJson = await createRes.Content.ReadFromJsonAsync<JsonElement>();
                var agentId   = agentJson.GetProperty("id").GetString()
                    ?? throw new Exception("Agent creation response missing 'id'");

                var agentA2aUrl = $"https://{apiHost}/agents/{agentId}";

                agentSingleton = new AgentSingleton(agentId, agentA2aUrl);
                logger.LogInformation("Corti agent created: {AgentId}", agentId);
            }
        }
        catch (Exception ex)
        {
            agentLock.Release();
            logger.LogError(ex, "Failed to create Corti agent");
            await SendSseAsync(new { type = "error", message = $"Failed to initialise agent: {ex.Message}" });
            return;
        }
        agentLock.Release();
    }

    // ── Build A2A message:send/stream request ────────────────────────────────
    // The A2A streaming endpoint is: POST {agentBaseUrl}/v1/message:stream
    // Body is a JSON-RPC 2.0 request with method "message/stream"
    var lastUserMsg = body.Messages.Last(m => m.Role == "user");
    var messageId   = Guid.NewGuid().ToString();

    var a2aRequest = new
    {
        jsonrpc = "2.0",
        id      = Guid.NewGuid().ToString(),
        method  = "message/stream",
        @params = new
        {
            message = new
            {
                role      = "user",
                kind      = "message",
                messageId,
                contextId = body.ContextId,
                parts     = new[]
                {
                    new { kind = "text", text = lastUserMsg.Content }
                }
            }
        }
    };

    // ── Get auth token for A2A call ─────────────────────────────────────────
    string accessToken;
    try
    {
        var authHost = env.Equals("us", StringComparison.OrdinalIgnoreCase)
            ? "auth.us.corti.app" : "auth.eu.corti.app";
        var tokenUrl = $"https://{authHost}/realms/{tn}/protocol/openid-connect/token";
        var http2    = httpClientFactory.CreateClient();
        var form     = new Dictionary<string, string>
        {
            ["grant_type"]    = "client_credentials",
            ["client_id"]     = cid,
            ["client_secret"] = cs,
            ["scope"]         = "openid",
        };
        var tokenRes = await http2.PostAsync(tokenUrl, new FormUrlEncodedContent(form), ct);
        tokenRes.EnsureSuccessStatusCode();
        var tokenJson = await tokenRes.Content.ReadFromJsonAsync<CortiTokenResponse>(cancellationToken: ct);
        accessToken = tokenJson?.AccessToken ?? throw new Exception("Empty token response");
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Token fetch for chat failed");
        await SendSseAsync(new { type = "error", message = $"Auth failed: {ex.Message}" });
        return;
    }

    // ── Call A2A message/stream endpoint ─────────────────────────────────────
    var streamUrl = $"{agentSingleton.AgentA2aUrl}/v1/message:stream";
    logger.LogInformation("Calling A2A stream: {Url}", streamUrl);

    try
    {
        using var httpClient = httpClientFactory.CreateClient();
        httpClient.Timeout = TimeSpan.FromMinutes(4);

        using var req = new HttpRequestMessage(HttpMethod.Post, streamUrl);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        req.Headers.Add("Tenant-Name", tn);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        req.Content = new StringContent(
            JsonSerializer.Serialize(a2aRequest),
            Encoding.UTF8,
            "application/json");

        using var response = await httpClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);

        if (!response.IsSuccessStatusCode)
        {
            var errBody = await response.Content.ReadAsStringAsync(ct);
            logger.LogError("A2A stream error {Status}: {Body}", response.StatusCode, errBody);
            await SendSseAsync(new { type = "error", message = $"Agent error ({response.StatusCode}): {errBody}" });
            return;
        }

        // ── Parse the SSE stream from Corti and forward relevant events ───────
        using var stream   = await response.Content.ReadAsStreamAsync(ct);
        using var reader   = new StreamReader(stream);

        string? newContextId = body.ContextId;
        double? credits      = null;
        var textBuffer       = new StringBuilder();
        var idleTimeout      = TimeSpan.FromSeconds(180);
        var lastActivity     = DateTime.UtcNow;

        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            // Idle timeout check
            if (DateTime.UtcNow - lastActivity > idleTimeout)
            {
                await SendSseAsync(new { type = "error", message = "Stream stalled — expert took too long. Try again or rephrase." });
                break;
            }

            var line = await reader.ReadLineAsync(ct);
            if (line is null) break;
            if (!line.StartsWith("data:")) continue;

            lastActivity = DateTime.UtcNow;
            var data = line["data:".Length..].Trim();
            if (data is "[DONE]" or "") continue;

            JsonDocument doc;
            try { doc = JsonDocument.Parse(data); }
            catch { continue; }

            using (doc)
            {
                var root = doc.RootElement;

                // JSON-RPC result or error wrapper
                JsonElement payload = root;
                if (root.TryGetProperty("result", out var resultEl))
                    payload = resultEl;
                else if (root.TryGetProperty("error", out var errEl))
                {
                    var errMsg = errEl.TryGetProperty("message", out var em) ? em.GetString() : errEl.GetRawText();
                    await SendSseAsync(new { type = "error", message = errMsg });
                    continue;
                }

                // Grab contextId from any event that carries it
                if (payload.TryGetProperty("contextId", out var ctxEl))
                    newContextId = ctxEl.GetString();

                // ── TaskStatusUpdateEvent ─────────────────────────────────
                if (payload.TryGetProperty("status", out var statusEl))
                {
                    // Check for a status message with parts (agent saying something via status)
                    if (statusEl.TryGetProperty("message", out var statusMsg) &&
                        statusMsg.TryGetProperty("parts", out var statusParts))
                    {
                        foreach (var part in statusParts.EnumerateArray())
                        {
                            if (part.TryGetProperty("kind", out var k) && k.GetString() == "text" &&
                                part.TryGetProperty("text", out var t))
                            {
                                await SendSseAsync(new { type = "status", message = t.GetString() ?? "" });
                            }
                        }
                    }

                    // State transitions
                    if (statusEl.TryGetProperty("state", out var stateEl))
                    {
                        var state = stateEl.GetString();
                        if (state is "completed" or "failed" or "canceled")
                        {
                            // Extract credits from metadata if present
                            if (payload.TryGetProperty("metadata", out var meta) &&
                                meta.TryGetProperty("credits", out var cr) &&
                                cr.ValueKind == JsonValueKind.Number)
                                credits = cr.GetDouble();

                            await SendSseAsync(new { type = "done", contextId = newContextId, credits });
                            return;
                        }
                    }
                    continue;
                }

                // ── TaskArtifactUpdateEvent (text chunks) ─────────────────
                if (payload.TryGetProperty("artifact", out var artifactEl) &&
                    artifactEl.TryGetProperty("parts", out var artifactParts))
                {
                    foreach (var part in artifactParts.EnumerateArray())
                    {
                        if (!part.TryGetProperty("kind", out var kindEl)) continue;
                        var kind = kindEl.GetString();

                        if (kind == "text" && part.TryGetProperty("text", out var textEl))
                        {
                            var chunk = textEl.GetString() ?? "";
                            if (!string.IsNullOrEmpty(chunk))
                                await SendSseAsync(new { type = "text", delta = chunk });
                        }
                        else if (kind == "data" && part.TryGetProperty("data", out var dataEl))
                        {
                            // data-status-update parts (expert activity indicators)
                            if (dataEl.TryGetProperty("type", out var dtEl) &&
                                dtEl.GetString() == "status_update" &&
                                dataEl.TryGetProperty("message", out var dmEl))
                            {
                                await SendSseAsync(new { type = "status", message = dmEl.GetString() ?? "" });
                            }
                        }
                    }
                    continue;
                }

                // ── Message response (non-task path) ──────────────────────
                if (payload.TryGetProperty("parts", out var msgParts) &&
                    payload.TryGetProperty("role", out var roleEl) &&
                    roleEl.GetString() == "agent")
                {
                    foreach (var part in msgParts.EnumerateArray())
                    {
                        if (part.TryGetProperty("kind", out var k2) && k2.GetString() == "text" &&
                            part.TryGetProperty("text", out var t2))
                        {
                            await SendSseAsync(new { type = "text", delta = t2.GetString() ?? "" });
                        }
                    }

                    // Extract credits
                    if (payload.TryGetProperty("metadata", out var meta2) &&
                        meta2.TryGetProperty("credits", out var cr2) &&
                        cr2.ValueKind == JsonValueKind.Number)
                        credits = cr2.GetDouble();

                    await SendSseAsync(new { type = "done", contextId = newContextId, credits });
                    return;
                }
            }
        }

        // Stream ended without explicit done
        await SendSseAsync(new { type = "done", contextId = newContextId, credits });
    }
    catch (OperationCanceledException)
    {
        // Client disconnected — normal
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Chat stream error");
        try { await SendSseAsync(new { type = "error", message = ex.Message }); } catch { }
    }
})
.WithName("Chat")
.WithTags("Assistant");

// ── GET /health ────────────────────────────────────────────────────────────────
app.MapGet("/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }))
   .WithName("Health");

app.Run();

// ── Types ──────────────────────────────────────────────────────────────────────
record CortiTokenResponse
{
    [JsonPropertyName("access_token")]  public string  AccessToken  { get; init; } = "";
    [JsonPropertyName("expires_in")]    public int     ExpiresIn    { get; init; }
    [JsonPropertyName("token_type")]    public string  TokenType    { get; init; } = "";
    [JsonPropertyName("refresh_token")] public string? RefreshToken { get; init; }
}

record ChatMessage(
    [property: JsonPropertyName("role")]    string Role,
    [property: JsonPropertyName("content")] string Content
);

record ChatRequest(
    [property: JsonPropertyName("messages")]  List<ChatMessage> Messages,
    [property: JsonPropertyName("contextId")] string?           ContextId
);

record AssemblyAiTokenResponse
{
    [JsonPropertyName("token")] public string? Token { get; init; }
}

record AgentSingleton(string AgentId, string AgentA2aUrl);

static class SseJsonOptions
{
    public static readonly JsonSerializerOptions Default = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

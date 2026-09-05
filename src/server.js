const http = require("http");
const { ProviderRouter } = require("./providers/ProviderRouter");
const { JobQueue } = require("./services/jobQueue");
const { listLanguages } = require("./config/languages");

const REQUEST_BODY_LIMIT = 2 * 1024 * 1024; // 2MB
const RESPONSE_TIMEOUT_MS = 30000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function normalizeCharacterVoices(input) {
  if (!input) return {};
  const out = {};
  for (const [name, cfg] of Object.entries(input)) {
    out[name.toUpperCase()] = cfg;
  }
  return out;
}

/**
 * Creates the AfriVoice backend. Zero external dependencies (built on
 * node:http) so it runs anywhere Node runs, with no install step.
 *
 * Frontend contract (unchanged from Step 7A's mock):
 *   POST /api/tts/generate         -> 202 { id, status, scenes: [...] }
 *   GET  /api/jobs/:jobId          -> { id, status, progress, scenes: [...] }
 *   GET  /api/jobs/:id/scenes/:i/audio -> real audio bytes
 *   GET  /api/tts/status           -> { realTTSAvailable, configuredProviders, languages }
 */
function createApp({ router = new ProviderRouter(), jobQueue } = {}) {
  const queue = jobQueue || new JobQueue(router);

  async function handle(req, res) {
    const timeout = setTimeout(() => {
      if (!res.writableEnded) sendJson(res, 504, { error: "Request timed out" });
    }, RESPONSE_TIMEOUT_MS);

    try {
      const url = new URL(req.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","tts","generate"]
      const joined = parts.join("/");

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        return res.end();
      }

      if (req.method === "GET" && joined === "api/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && joined === "api/tts/status") {
        const configured = router.configuredProviders().map((p) => p.id);
        return sendJson(res, 200, {
          realTTSAvailable: configured.length > 0,
          configuredProviders: configured,
          languages: listLanguages(),
        });
      }

      if (req.method === "POST" && joined === "api/tts/generate") {
        const body = await readJsonBody(req);
        const { script, langCode, format, defaultVoice, characterVoices } = body || {};

        if (!script || typeof script !== "string" || !script.trim()) {
          return sendJson(res, 400, { error: "`script` is required." });
        }
        if (!langCode) {
          return sendJson(res, 400, { error: "`langCode` is required." });
        }
        if (!defaultVoice || !defaultVoice.voiceId) {
          return sendJson(res, 400, { error: "`defaultVoice.voiceId` is required." });
        }
        if (!router.anyProviderConfigured()) {
          return sendJson(res, 503, { error: "Real TTS is not configured", code: "NOT_CONFIGURED" });
        }

        try {
          const job = queue.createJob({
            script,
            langCode,
            format,
            defaultVoice,
            characterVoices: normalizeCharacterVoices(characterVoices),
          });
          return sendJson(res, 202, job);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "jobs" && parts.length === 3) {
        const job = queue.getJob(parts[2]);
        if (!job) return sendJson(res, 404, { error: "Job not found" });
        return sendJson(res, 200, job);
      }

      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "jobs" &&
        parts[3] === "scenes" &&
        parts[5] === "audio" &&
        parts.length === 6
      ) {
        const segment = queue.getSegmentAudio(parts[2], parts[4]);
        if (!segment) return sendJson(res, 404, { error: "Audio not available for this scene yet" });
        res.writeHead(200, {
          "Content-Type": segment.contentType,
          "Content-Disposition": `attachment; filename="scene-${parts[4]}.${segment.format}"`,
          "Content-Length": segment.audioBuffer.length,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(segment.audioBuffer);
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[AfriVoice API error]", err);
      if (!res.writableEnded) sendJson(res, err.status || 500, { error: err.message || "Internal server error" });
    } finally {
      clearTimeout(timeout);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  return { server, router, jobQueue: queue };
}

if (require.main === module) {
  const { server } = createApp();
  const port = process.env.PORT || 8787;
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`AfriVoice TTS backend listening on :${port}`);
  });
}

module.exports = { createApp };

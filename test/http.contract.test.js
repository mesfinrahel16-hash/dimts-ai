const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/server");

function request(server, { method = "GET", path, body }) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const http = require("http");
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, headers: res.headers, raw });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(fn) {
  const { server } = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await fn(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health check", async () => {
  await withServer(async (server) => {
    const res = await request(server, { path: "/api/health" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  });
});

test("no credentials: /api/tts/status reports realTTSAvailable=false", async () => {
  const prevKey = process.env.AZURE_SPEECH_KEY;
  const prevRegion = process.env.AZURE_SPEECH_REGION;
  const prevEl = process.env.ELEVENLABS_API_KEY;
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  delete process.env.ELEVENLABS_API_KEY;

  await withServer(async (server) => {
    const res = await request(server, { path: "/api/tts/status" });
    assert.equal(res.status, 200);
    assert.equal(res.json.realTTSAvailable, false);
    assert.deepEqual(res.json.configuredProviders, []);
    // Language matrix must be present and Amharic must be marked Azure-supported
    const am = res.json.languages.find((l) => l.code === "am-ET");
    assert.ok(am);
    assert.equal(am.providers.azure.supported, true);
    const ti = res.json.languages.find((l) => l.code === "ti-ET");
    assert.equal(ti.providers.azure.supported, false);
    assert.equal(ti.providers.elevenlabs.supported, false);
  });

  if (prevKey) process.env.AZURE_SPEECH_KEY = prevKey;
  if (prevRegion) process.env.AZURE_SPEECH_REGION = prevRegion;
  if (prevEl) process.env.ELEVENLABS_API_KEY = prevEl;
});

test("real TTS disabled: /api/tts/generate returns 503 NOT_CONFIGURED with no credentials", async () => {
  const prevKey = process.env.AZURE_SPEECH_KEY;
  const prevRegion = process.env.AZURE_SPEECH_REGION;
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;

  await withServer(async (server) => {
    const res = await request(server, {
      method: "POST",
      path: "/api/tts/generate",
      body: {
        script: "SCENE 01 — NIGHT\nNARRATOR:\nHello there.",
        langCode: "am-ET",
        defaultVoice: { voiceId: "am-ET-AmehaNeural", provider: "azure" },
      },
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.code, "NOT_CONFIGURED");
    assert.equal(res.json.error, "Real TTS is not configured");
  });

  if (prevKey) process.env.AZURE_SPEECH_KEY = prevKey;
  if (prevRegion) process.env.AZURE_SPEECH_REGION = prevRegion;
});

test("validation: missing script/langCode/voice returns 400", async () => {
  process.env.AZURE_SPEECH_KEY = "fake-key-for-validation-test";
  process.env.AZURE_SPEECH_REGION = "eastus";

  await withServer(async (server) => {
    const r1 = await request(server, { method: "POST", path: "/api/tts/generate", body: {} });
    assert.equal(r1.status, 400);

    const r2 = await request(server, {
      method: "POST",
      path: "/api/tts/generate",
      body: { script: "x", langCode: "am-ET" },
    });
    assert.equal(r2.status, 400);
  });

  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
});

test("unsupported language: Tigrinya is rejected even with credentials present", async () => {
  process.env.AZURE_SPEECH_KEY = "fake-key-for-validation-test";
  process.env.AZURE_SPEECH_REGION = "eastus";

  await withServer(async (server) => {
    const res = await request(server, {
      method: "POST",
      path: "/api/tts/generate",
      body: {
        script: "SCENE 01 — NIGHT\nNARRATOR:\nSelam.",
        langCode: "ti-ET",
        defaultVoice: { voiceId: "some-voice", provider: "azure" },
      },
    });
    assert.equal(res.status, 202); // job is accepted, then fails async per-scene
    // Poll until failed
    let job = res.json;
    for (let i = 0; i < 20 && job.status === "processing"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const poll = await request(server, { path: `/api/jobs/${job.id}` });
      job = poll.json;
    }
    assert.equal(job.status, "failed");
    assert.match(job.error, /ti-ET/);
  });

  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
});

test("job not found returns 404", async () => {
  await withServer(async (server) => {
    const res = await request(server, { path: "/api/jobs/does-not-exist" });
    assert.equal(res.status, 404);
  });
});

test("scene audio not ready returns 404", async () => {
  await withServer(async (server) => {
    const res = await request(server, { path: "/api/jobs/does-not-exist/scenes/0/audio" });
    assert.equal(res.status, 404);
  });
});

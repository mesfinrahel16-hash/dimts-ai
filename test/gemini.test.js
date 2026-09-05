const test = require("node:test");
const assert = require("node:assert/strict");
const { isSupported, getVoicesFor } = require("../src/config/languages");
const { GeminiTTSProvider } = require("../src/providers/GeminiTTSProvider");
const { ProviderRouter } = require("../src/providers/ProviderRouter");
const { JobQueue } = require("../src/services/jobQueue");

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function withMockedFetch(impl, fn) {
  const prevFetch = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = prevFetch;
    });
}

/** Builds a fake Gemini generateContent success response with raw PCM audio. */
function fakeGeminiResponse(pcmBuffer) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcmBuffer.toString("base64") } }],
          },
        },
      ],
    }),
  };
}

test("language matrix: Gemini is verified for Amharic only, not English/Tigrinya/Oromo", () => {
  assert.equal(isSupported("am-ET", "gemini"), true);
  assert.equal(isSupported("en-US", "gemini"), false);
  assert.equal(isSupported("ti-ET", "gemini"), false);
  assert.equal(isSupported("om-ET", "gemini"), false);

  const voices = getVoicesFor("am-ET", "gemini");
  assert.ok(voices.some((v) => v.id === "Kore"));
});

test("GeminiTTSProvider: isConfigured() reflects GEMINI_API_KEY presence only", async () => {
  await withEnv({ GEMINI_API_KEY: undefined }, () => {
    const provider = new GeminiTTSProvider();
    assert.equal(provider.isConfigured(), false);
  });
  await withEnv({ GEMINI_API_KEY: "fake-key-for-test" }, () => {
    const provider = new GeminiTTSProvider();
    assert.equal(provider.isConfigured(), true);
  });
});

test("GeminiTTSProvider: synthesize() refuses when not configured (no fake success)", async () => {
  await withEnv({ GEMINI_API_KEY: undefined }, async () => {
    const provider = new GeminiTTSProvider();
    await assert.rejects(
      () => provider.synthesize({ text: "selam", langCode: "am-ET", voiceId: "Kore", format: "wav" }),
      /not configured/
    );
  });
});

test("GeminiTTSProvider: synthesize() refuses unsupported language even if configured", async () => {
  await withEnv({ GEMINI_API_KEY: "fake-key-for-test" }, async () => {
    const provider = new GeminiTTSProvider();
    await assert.rejects(
      () => provider.synthesize({ text: "hello", langCode: "en-US", voiceId: "Kore", format: "wav" }),
      /not enabled for language "en-US"/
    );
  });
});

test("GeminiTTSProvider: mocked successful response returns a valid, correctly-sized WAV", async () => {
  const fakePcm = Buffer.alloc(4800, 0); // 0.1s of silence at 24kHz/16-bit/mono
  await withEnv({ GEMINI_API_KEY: "fake-key-for-test" }, () =>
    withMockedFetch(
      async (url, opts) => {
        assert.match(url, /gemini-2\.5-flash-preview-tts:generateContent/);
        const body = JSON.parse(opts.body);
        assert.equal(body.contents[0].parts[0].text, "የከተማይቱ ጸጥታ ያየለ ነበር።");
        assert.equal(body.generationConfig.responseModalities[0], "AUDIO");
        assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
        assert.equal(opts.headers["x-goog-api-key"], "fake-key-for-test");
        return fakeGeminiResponse(fakePcm);
      },
      async () => {
        const provider = new GeminiTTSProvider();
        const result = await provider.synthesize({
          text: "የከተማይቱ ጸጥታ ያየለ ነበር።",
          langCode: "am-ET",
          voiceId: "Kore",
          format: "wav",
        });
        assert.equal(result.format, "wav");
        assert.equal(result.contentType, "audio/wav");
        assert.equal(result.audioBuffer.toString("ascii", 0, 4), "RIFF");
        assert.equal(result.audioBuffer.toString("ascii", 8, 12), "WAVE");
        const declaredDataSize = result.audioBuffer.readUInt32LE(40);
        assert.equal(declaredDataSize, fakePcm.length);
        assert.equal(result.audioBuffer.length, 44 + fakePcm.length);
      }
    )
  );
});

test("GeminiTTSProvider: real provider error response surfaces honestly, never faked as success", async () => {
  await withEnv({ GEMINI_API_KEY: "fake-key-for-test" }, () =>
    withMockedFetch(
      async () => ({ ok: false, status: 401, text: async () => "API key invalid" }),
      async () => {
        const provider = new GeminiTTSProvider();
        await assert.rejects(
          () => provider.synthesize({ text: "selam", langCode: "am-ET", voiceId: "Kore", format: "wav" }),
          /Gemini TTS request failed \(401\)/
        );
      }
    )
  );
});

test("ProviderRouter: routes Amharic to Gemini when only Gemini is configured", async () => {
  await withEnv({ AZURE_SPEECH_KEY: undefined, AZURE_SPEECH_REGION: undefined, ELEVENLABS_API_KEY: undefined, GEMINI_API_KEY: "fake-key-for-test" }, () => {
    const router = new ProviderRouter();
    const provider = router.resolve({ langCode: "am-ET" });
    assert.equal(provider.id, "gemini");
  });
});

test("ProviderRouter: with nothing configured, resolving Amharic reports 'not configured', not a fake voice", async () => {
  await withEnv({ AZURE_SPEECH_KEY: undefined, AZURE_SPEECH_REGION: undefined, ELEVENLABS_API_KEY: undefined, GEMINI_API_KEY: undefined }, () => {
    const router = new ProviderRouter();
    assert.throws(() => router.resolve({ langCode: "am-ET" }), /No TTS provider is configured/);
  });
});

test("pipeline + audio retrieval: full job completes end-to-end through Gemini with mocked response", async () => {
  const fakePcm = Buffer.alloc(2400, 0); // 0.05s silence
  await withEnv({ AZURE_SPEECH_KEY: undefined, AZURE_SPEECH_REGION: undefined, ELEVENLABS_API_KEY: undefined, GEMINI_API_KEY: "fake-key-for-test" }, () =>
    withMockedFetch(
      async () => fakeGeminiResponse(fakePcm),
      async () => {
        const router = new ProviderRouter();
        const queue = new JobQueue(router);

        const created = queue.createJob({
          script: `SCENE 01 — NIGHT — ADDIS ABABA\nNARRATOR:\nየከተማይቱ ጸጥታ ያየለ ነበር።`,
          langCode: "am-ET",
          format: "wav",
          defaultVoice: { voiceId: "Kore", provider: "gemini" },
          characterVoices: {},
        });

        const finalJob = await new Promise((resolve, reject) => {
          const start = Date.now();
          const tick = () => {
            const job = queue.getJob(created.id);
            if (job.status === "complete" || job.status === "failed") return resolve(job);
            if (Date.now() - start > 3000) return reject(new Error("timed out"));
            setTimeout(tick, 10);
          };
          tick();
        });

        assert.equal(finalJob.status, "complete");
        assert.equal(finalJob.scenes[0].status, "generated");
        assert.ok(finalJob.scenes[0].audioUrl);

        // Frontend retrieval path: GET /api/jobs/:id/scenes/:i/audio equivalent.
        const segment = queue.getSegmentAudio(created.id, 0);
        assert.ok(segment);
        assert.equal(segment.audioBuffer.toString("ascii", 0, 4), "RIFF");
        assert.equal(segment.audioBuffer.toString("ascii", 8, 12), "WAVE");
        assert.equal(segment.contentType, "audio/wav");
      }
    )
  );
});

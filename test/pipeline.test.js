const test = require("node:test");
const assert = require("node:assert/strict");
const { JobQueue } = require("../src/services/jobQueue");
const { buildWavHeader } = require("../src/services/audioMerge");

/**
 * Fake provider standing in for Azure/ElevenLabs so the pipeline
 * (Script -> Scene -> Dialogue -> Voice Job -> Provider -> Audio Segment
 * -> Job completion) can be exercised deterministically and offline.
 * It returns real, valid WAV bytes (silence) so downstream WAV-merge logic
 * is exercised for real, not mocked away.
 */
function makeFakeRouter({ failFor } = {}) {
  const calls = [];
  return {
    calls,
    configuredProviders: () => [{ id: "fake" }],
    anyProviderConfigured: () => true,
    async synthesize({ text, langCode, voiceId }) {
      calls.push({ text, langCode, voiceId });
      if (failFor && text.includes(failFor)) {
        const err = new Error(`Fake provider refused: "${failFor}"`);
        err.status = 422;
        throw err;
      }
      const seconds = 0.05;
      const sampleRate = 24000;
      const bitsPerSample = 16;
      const numChannels = 1;
      const dataLength = Math.floor(sampleRate * seconds) * numChannels * (bitsPerSample / 8);
      const data = Buffer.alloc(dataLength, 0);
      const header = buildWavHeader(dataLength, { sampleRate, bitsPerSample, numChannels });
      return { audioBuffer: Buffer.concat([header, data]), contentType: "audio/wav", format: "wav" };
    },
  };
}

function waitForCompletion(queue, jobId, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const job = queue.getJob(jobId);
      if (job.status === "complete" || job.status === "failed") return resolve(job);
      if (Date.now() - start > timeoutMs) return reject(new Error("Timed out waiting for job"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("pipeline: multi-scene script preserves scene order end to end", async () => {
  const router = makeFakeRouter();
  const queue = new JobQueue(router);
  const script = `SCENE 01 — NIGHT
NARRATOR:
First scene line.

SCENE 02 — DAY
NARRATOR:
Second scene line.

SCENE 03 — DUSK
NARRATOR:
Third scene line.`;

  const created = queue.createJob({
    script,
    langCode: "am-ET",
    format: "wav",
    defaultVoice: { voiceId: "am-ET-AmehaNeural", provider: "azure" },
    characterVoices: {},
  });

  const finalJob = await waitForCompletion(queue, created.id);
  assert.equal(finalJob.status, "complete");
  assert.equal(finalJob.scenes.length, 3);
  assert.deepEqual(
    finalJob.scenes.map((s) => s.index),
    [0, 1, 2]
  );
  assert.ok(finalJob.scenes.every((s) => s.status === "generated"));
  assert.ok(finalJob.scenes.every((s) => s.audioUrl));
});

test("pipeline: character-to-voice assignment is respected per line", async () => {
  const router = makeFakeRouter();
  const queue = new JobQueue(router);
  const script = `SCENE 01 — NIGHT
NARRATOR:
Narration line.

MICHAEL:
Michael's line.

FATHER:
Father's line.`;

  const created = queue.createJob({
    script,
    langCode: "am-ET",
    format: "wav",
    defaultVoice: { voiceId: "default-voice", provider: "azure" },
    characterVoices: {
      NARRATOR: { voiceId: "narrator-voice", provider: "azure" },
      MICHAEL: { voiceId: "michael-voice", provider: "azure" },
      FATHER: { voiceId: "father-voice", provider: "azure" },
    },
  });

  await waitForCompletion(queue, created.id);

  const voicesUsed = router.calls.map((c) => c.voiceId);
  assert.deepEqual(voicesUsed, ["narrator-voice", "michael-voice", "father-voice"]);
});

test("pipeline: falls back to defaultVoice for unassigned characters", async () => {
  const router = makeFakeRouter();
  const queue = new JobQueue(router);
  const script = `SCENE 01 — NIGHT
STRANGER:
Unassigned character line.`;

  const created = queue.createJob({
    script,
    langCode: "en-US",
    format: "wav",
    defaultVoice: { voiceId: "default-voice", provider: "azure" },
    characterVoices: {},
  });

  await waitForCompletion(queue, created.id);
  assert.equal(router.calls[0].voiceId, "default-voice");
});

test("pipeline: Amharic (am-ET) request reaches the provider with the correct langCode", async () => {
  const router = makeFakeRouter();
  const queue = new JobQueue(router);
  const created = queue.createJob({
    script: `SCENE 01 — NIGHT\nNARRATOR:\nየከተማይቱ ጸጥታ ያየለ ነበር።`,
    langCode: "am-ET",
    format: "wav",
    defaultVoice: { voiceId: "am-ET-AmehaNeural", provider: "azure" },
    characterVoices: {},
  });
  const job = await waitForCompletion(queue, created.id);
  assert.equal(job.status, "complete");
  assert.equal(router.calls[0].langCode, "am-ET");
  assert.match(router.calls[0].text, /ጸጥታ/);
});

test("pipeline: English (en-US) request reaches the provider with the correct langCode", async () => {
  const router = makeFakeRouter();
  const queue = new JobQueue(router);
  const created = queue.createJob({
    script: `SCENE 01 — DAY\nNARRATOR:\nThe market was alive with color.`,
    langCode: "en-US",
    format: "wav",
    defaultVoice: { voiceId: "en-US-JennyNeural", provider: "azure" },
    characterVoices: {},
  });
  const job = await waitForCompletion(queue, created.id);
  assert.equal(job.status, "complete");
  assert.equal(router.calls[0].langCode, "en-US");
});

test("pipeline: provider failure surfaces as a real failed job, never fake success", async () => {
  const router = makeFakeRouter({ failFor: "BOOM" });
  const queue = new JobQueue(router);
  const created = queue.createJob({
    script: `SCENE 01 — NIGHT\nNARRATOR:\nThis line will BOOM.`,
    langCode: "en-US",
    format: "wav",
    defaultVoice: { voiceId: "en-US-JennyNeural", provider: "azure" },
    characterVoices: {},
  });
  const job = await waitForCompletion(queue, created.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /BOOM|failed/);
  assert.equal(job.scenes[0].status, "failed");
});

test("pipeline: missing voice assignment with no defaultVoice fails cleanly", async () => {
  const router = makeFakeRouter();
  const queue = new JobQueue(router);
  const created = queue.createJob({
    script: `SCENE 01 — NIGHT\nNARRATOR:\nNo voice configured.`,
    langCode: "en-US",
    format: "wav",
    defaultVoice: null,
    characterVoices: {},
  });
  const job = await waitForCompletion(queue, created.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /No voice assigned/);
});

test("pipeline: real generated audio is retrievable and is a valid WAV", async () => {
  const router = makeFakeRouter();
  const queue = new JobQueue(router);
  const created = queue.createJob({
    script: `SCENE 01 — NIGHT\nNARRATOR:\nAudio retrieval test.`,
    langCode: "en-US",
    format: "wav",
    defaultVoice: { voiceId: "en-US-JennyNeural", provider: "azure" },
    characterVoices: {},
  });
  await waitForCompletion(queue, created.id);
  const segment = queue.getSegmentAudio(created.id, 0);
  assert.ok(segment);
  assert.equal(segment.audioBuffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(segment.audioBuffer.toString("ascii", 8, 12), "WAVE");
});

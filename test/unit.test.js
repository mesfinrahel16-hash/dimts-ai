const test = require("node:test");
const assert = require("node:assert/strict");
const { isSupported, getVoicesFor } = require("../src/config/languages");
const { parseScript } = require("../src/services/scriptParser");
const { mergeWavBuffers, buildWavHeader, combineDialogueBuffers } = require("../src/services/audioMerge");
const { ProviderRouter } = require("../src/providers/ProviderRouter");

test("language matrix: Amharic verified on Azure, English on both, Tigrinya/Oromo unsupported", () => {
  assert.equal(isSupported("am-ET", "azure"), true);
  assert.equal(isSupported("en-US", "azure"), true);
  assert.equal(isSupported("en-US", "elevenlabs"), true);
  assert.equal(isSupported("ti-ET", "azure"), false);
  assert.equal(isSupported("ti-ET", "elevenlabs"), false);
  assert.equal(isSupported("om-ET", "azure"), false);
  assert.equal(isSupported("om-ET", "elevenlabs"), false);

  const amVoices = getVoicesFor("am-ET", "azure");
  assert.ok(amVoices.some((v) => v.id === "am-ET-AmehaNeural"));
  assert.ok(amVoices.some((v) => v.id === "am-ET-MekdesNeural"));
});

test("scriptParser: preserves scene order and character attribution", () => {
  const script = `SCENE 01 — NIGHT — ADDIS ABABA

NARRATOR:
The city was quiet.

MICHAEL:
I don't know what to do.

SCENE 02 — DAY — MARKET

MICHAEL:
Second scene line.`;

  const scenes = parseScript(script);
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].index, 0);
  assert.equal(scenes[1].index, 1);
  assert.equal(scenes[0].dialogue[0].character, "NARRATOR");
  assert.equal(scenes[0].dialogue[1].character, "MICHAEL");
  assert.equal(scenes[1].dialogue[0].text, "Second scene line.");
});

test("scriptParser: ignores action lines with no active character", () => {
  const script = `SCENE 01 — NIGHT
He walks slowly toward the door.
NARRATOR:
Finally, he speaks.`;
  const scenes = parseScript(script);
  assert.equal(scenes[0].dialogue.length, 1);
  assert.equal(scenes[0].dialogue[0].character, "NARRATOR");
});

function makeSilentWav({ sampleRate = 24000, bitsPerSample = 16, numChannels = 1, seconds = 0.1 }) {
  const dataLength = Math.floor(sampleRate * seconds) * numChannels * (bitsPerSample / 8);
  const data = Buffer.alloc(dataLength, 0);
  const header = buildWavHeader(dataLength, { sampleRate, bitsPerSample, numChannels });
  return Buffer.concat([header, data]);
}

test("audioMerge: WAV merge produces a valid, correctly-sized header (no corruption)", () => {
  const a = makeSilentWav({ seconds: 0.1 });
  const b = makeSilentWav({ seconds: 0.2 });
  const merged = mergeWavBuffers([a, b]);

  assert.equal(merged.toString("ascii", 0, 4), "RIFF");
  assert.equal(merged.toString("ascii", 8, 12), "WAVE");
  const declaredRiffSize = merged.readUInt32LE(4);
  assert.equal(declaredRiffSize, merged.length - 8);
  const declaredDataSize = merged.readUInt32LE(40);
  assert.equal(declaredDataSize, merged.length - 44);
});

test("audioMerge: mismatched WAV sample formats refuse to merge", () => {
  const a = makeSilentWav({ sampleRate: 24000 });
  const b = makeSilentWav({ sampleRate: 16000 });
  assert.throws(() => mergeWavBuffers([a, b]), /mismatched sample format/);
});

test("audioMerge: MP3 multi-segment merge is explicitly reported as incomplete, never faked", () => {
  const fakeMp3A = { audioBuffer: Buffer.from([0xff, 0xfb, 1, 2, 3]), contentType: "audio/mpeg" };
  const fakeMp3B = { audioBuffer: Buffer.from([0xff, 0xfb, 4, 5, 6]), contentType: "audio/mpeg" };
  const result = combineDialogueBuffers([fakeMp3A, fakeMp3B], "mp3");
  assert.equal(result.mergeIncomplete, true);
  assert.match(result.note, /Step 7C/);
  // Must NOT be a naive concatenation of both buffers
  assert.notEqual(result.audioBuffer.length, fakeMp3A.audioBuffer.length + fakeMp3B.audioBuffer.length);
});

test("audioMerge: single-segment scenes pass through untouched", () => {
  const only = { audioBuffer: Buffer.from([1, 2, 3]), contentType: "audio/mpeg" };
  const result = combineDialogueBuffers([only], "mp3");
  assert.equal(result.mergeIncomplete, false);
  assert.deepEqual(result.audioBuffer, only.audioBuffer);
});

test("ProviderRouter: distinguishes 'not configured' from 'configured but unsupported language'", () => {
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  delete process.env.ELEVENLABS_API_KEY;

  const router = new ProviderRouter();
  assert.throws(() => router.resolve({ langCode: "am-ET" }), /No TTS provider is configured/);

  process.env.AZURE_SPEECH_KEY = "fake";
  process.env.AZURE_SPEECH_REGION = "eastus";
  const router2 = new ProviderRouter();
  assert.throws(() => router2.resolve({ langCode: "ti-ET" }), /No configured provider supports "ti-ET"/);

  const provider = router2.resolve({ langCode: "am-ET" });
  assert.equal(provider.id, "azure");

  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
});

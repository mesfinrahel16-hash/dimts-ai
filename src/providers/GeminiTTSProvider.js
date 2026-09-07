const { TTSProvider } = require("./TTSProvider");
const { isSupported, getVoicesFor } = require("../config/languages");
const { ProviderError } = require("./AzureTTSProvider");
const { buildWavHeader } = require("../services/audioMerge");

const GEMINI_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 20000;

// Gemini TTS always returns raw PCM: 24kHz, 16-bit, mono (per Google's
// published TTS docs). We wrap it into a proper WAV header ourselves rather
// than trusting a claimed container format.
const GEMINI_PCM_FORMAT = { sampleRate: 24000, bitsPerSample: 16, numChannels: 1 };

/**
 * Google Gemini TTS adapter, scoped to Amharic for this integration (see
 * config/languages.js for the exact reasoning). Gemini TTS has no separate
 * "language" request parameter — it auto-detects the spoken language from
 * the input text — so `langCode` here is used only for our own support-matrix
 * gating, not sent to the API.
 */
class GeminiTTSProvider extends TTSProvider {
  get id() {
    return "gemini";
  }

  get name() {
    return "Google Gemini TTS";
  }

  isConfigured() {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  supportsLanguage(langCode) {
    return isSupported(langCode, "gemini");
  }

  isValidVoice(langCode, voiceId) {
    const voices = getVoicesFor(langCode, "gemini");
    return voices.some((v) => v.id === voiceId);
  }

  async synthesize({ text, langCode, voiceId, format = "wav" }) {
    if (!this.isConfigured()) {
      throw new ProviderError("Gemini TTS is not configured (missing GEMINI_API_KEY).", 503);
    }
    if (!this.supportsLanguage(langCode)) {
      throw new ProviderError(`Gemini TTS is not enabled for language "${langCode}" in this integration.`, 422);
    }
    if (!this.isValidVoice(langCode, voiceId)) {
      throw new ProviderError(`"${voiceId}" is not a recognized Gemini TTS voice for "${langCode}".`, 422);
    }
    if (format !== "wav") {
      // Gemini returns raw PCM, not a compressed container. Rather than
      // fake an MP3 by mislabeling PCM bytes, we're explicit about the gap.
      throw new ProviderError(
        `Gemini TTS output is raw PCM in this integration; only "wav" is supported (requested "${format}"). MP3 encoding is not implemented.`,
        422
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } },
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ProviderError(`Gemini TTS request failed (${res.status}): ${detail.slice(0, 300)}`, res.status);
      }

      const json = await res.json();
      const part = json?.candidates?.[0]?.content?.parts?.[0];
      const base64Data = part?.inlineData?.data;
      if (!base64Data) {
        throw new ProviderError("Gemini TTS response did not include audio data.", 502);
      }

      const pcm = Buffer.from(base64Data, "base64");
      const header = buildWavHeader(pcm.length, GEMINI_PCM_FORMAT);
      const wavBuffer = Buffer.concat([header, pcm]);

      return { audioBuffer: wavBuffer, contentType: "audio/wav", format: "wav" };
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ProviderError("Gemini TTS request timed out", 504);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { GeminiTTSProvider };

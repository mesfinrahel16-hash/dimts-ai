const { TTSProvider } = require("./TTSProvider");
const { isSupported } = require("../config/languages");
const { ProviderError } = require("./AzureTTSProvider");

const REQUEST_TIMEOUT_MS = 20000;

/**
 * ElevenLabs adapter. Kept as a provider option in the router, but per
 * ElevenLabs' own published language list, Eleven Multilingual v2 / Flash
 * v2.5 do NOT include Amharic, Tigrinya, or Afaan Oromo — only English is
 * marked supported for this app's language set (see config/languages.js).
 * This adapter refuses (rather than silently mis-synthesizes) any
 * unsupported language.
 */
class ElevenLabsProvider extends TTSProvider {
  get id() {
    return "elevenlabs";
  }

  get name() {
    return "ElevenLabs";
  }

  isConfigured() {
    return Boolean(process.env.ELEVENLABS_API_KEY);
  }

  supportsLanguage(langCode) {
    return isSupported(langCode, "elevenlabs");
  }

  async synthesize({ text, langCode, voiceId, format = "mp3" }) {
    if (!this.isConfigured()) {
      throw new ProviderError("ElevenLabs is not configured (missing ELEVENLABS_API_KEY).", 503);
    }
    if (!this.supportsLanguage(langCode)) {
      throw new ProviderError(
        `ElevenLabs does not publish TTS support for language "${langCode}". Use Azure for this language.`,
        422
      );
    }
    if (!voiceId) {
      throw new ProviderError("A voiceId is required for ElevenLabs synthesis.", 422);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: format === "wav" ? "audio/wav" : "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ProviderError(`ElevenLabs TTS request failed (${res.status}): ${detail.slice(0, 300)}`, res.status);
      }

      const arrayBuffer = await res.arrayBuffer();
      return {
        audioBuffer: Buffer.from(arrayBuffer),
        contentType: format === "wav" ? "audio/wav" : "audio/mpeg",
        format,
      };
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ProviderError("ElevenLabs request timed out", 504);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { ElevenLabsProvider };

const { TTSProvider } = require("./TTSProvider");
const { isSupported, getVoicesFor } = require("../config/languages");
const { buildSSML } = require("../services/ssmlBuilder");

// Azure output formats: 24kHz mono MP3 for streaming/preview,
// riff-24khz-16bit-mono-pcm for a clean, mergeable WAV.
const AZURE_OUTPUT_FORMAT = {
  mp3: "audio-24khz-96kbitrate-mono-mp3",
  wav: "riff-24khz-16bit-mono-pcm",
};

const REQUEST_TIMEOUT_MS = 15000;

class AzureTTSProvider extends TTSProvider {
  get id() {
    return "azure";
  }

  get name() {
    return "Azure Speech";
  }

  isConfigured() {
    return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
  }

  supportsLanguage(langCode) {
    return isSupported(langCode, "azure");
  }

  /**
   * Validate that the requested voiceId is one of the verified voices for
   * this language, rather than trusting client input blindly.
   */
  isValidVoice(langCode, voiceId) {
    const voices = getVoicesFor(langCode, "azure");
    return voices.some((v) => v.id === voiceId);
  }

  async _getAccessToken() {
    const region = process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": key, "Content-Length": "0" },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ProviderError(`Azure token request failed (${res.status})`, res.status);
      }
      return await res.text();
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ProviderError("Azure token request timed out", 504);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async synthesize({ text, isSSML, langCode, voiceId, speed = 1, pitchSemitones = 0, style, format = "mp3" }) {
    if (!this.isConfigured()) {
      throw new ProviderError("Azure Speech is not configured (missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION).", 503);
    }
    if (!this.supportsLanguage(langCode)) {
      throw new ProviderError(`Azure Speech does not have a verified voice for language "${langCode}".`, 422);
    }
    if (!this.isValidVoice(langCode, voiceId)) {
      throw new ProviderError(`"${voiceId}" is not a verified Azure voice for "${langCode}".`, 422);
    }

    const region = process.env.AZURE_SPEECH_REGION;
    const token = await this._getAccessToken();

    const ssml = isSSML
      ? text
      : buildSSML({ text, langCode, voiceId, speed, pitchSemitones, style, styleSupportedByVoice: false });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": AZURE_OUTPUT_FORMAT[format] || AZURE_OUTPUT_FORMAT.mp3,
          "User-Agent": "AfriVoiceAI",
        },
        body: ssml,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ProviderError(`Azure TTS request failed (${res.status}): ${detail.slice(0, 300)}`, res.status);
      }

      const arrayBuffer = await res.arrayBuffer();
      return {
        audioBuffer: Buffer.from(arrayBuffer),
        contentType: format === "wav" ? "audio/wav" : "audio/mpeg",
        format,
      };
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ProviderError("Azure TTS request timed out", 504);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class ProviderError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

module.exports = { AzureTTSProvider, ProviderError };

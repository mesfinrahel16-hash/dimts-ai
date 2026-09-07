/**
 * Abstract base class for all TTS provider adapters.
 * ProviderRouter only ever talks to this interface — it never knows about
 * Azure or ElevenLabs specifics directly.
 */
class TTSProvider {
  /** Unique id, e.g. "azure", "elevenlabs" */
  get id() {
    throw new Error("Provider must implement id");
  }

  /** Human-readable name for logs/UI */
  get name() {
    throw new Error("Provider must implement name");
  }

  /**
   * Whether this provider has valid server-side credentials configured.
   * Must NEVER read from the request — only from server-side env vars.
   * @returns {boolean}
   */
  isConfigured() {
    throw new Error("Provider must implement isConfigured()");
  }

  /**
   * Whether this provider actually supports TTS for the given language code.
   * Must be backed by the verified languages.js matrix, not a guess.
   * @param {string} langCode BCP-47 code, e.g. "am-ET"
   * @returns {boolean}
   */
  supportsLanguage(langCode) {
    throw new Error("Provider must implement supportsLanguage()");
  }

  /**
   * Synthesize a single segment of speech.
   * @param {object} params
   * @param {string} params.text - plain text or pre-built SSML
   * @param {boolean} params.isSSML - whether params.text is SSML
   * @param {string} params.langCode - BCP-47 language code
   * @param {string} params.voiceId - provider-specific voice id
   * @param {number} [params.speed] - 0.5–2.0
   * @param {number} [params.pitchSemitones] - -12..12
   * @param {string} [params.format] - "mp3" | "wav"
   * @returns {Promise<{ audioBuffer: Buffer, contentType: string, format: string }>}
   */
  async synthesize(_params) {
    throw new Error("Provider must implement synthesize()");
  }
}

module.exports = { TTSProvider };

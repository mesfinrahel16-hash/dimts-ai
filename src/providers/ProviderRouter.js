const { AzureTTSProvider, ProviderError } = require("./AzureTTSProvider");
const { ElevenLabsProvider } = require("./ElevenLabsProvider");
const { GeminiTTSProvider } = require("./GeminiTTSProvider");

/**
 * ProviderRouter is the only thing the rest of the backend talks to for
 * synthesis. It owns provider selection so routes never hardcode "Azure",
 * "ElevenLabs", or "Gemini" directly.
 */
class ProviderRouter {
  constructor(providers = [new AzureTTSProvider(), new ElevenLabsProvider(), new GeminiTTSProvider()]) {
    this.providers = providers;
  }

  getProvider(id) {
    return this.providers.find((p) => p.id === id) || null;
  }

  /** Providers with valid server-side credentials right now. */
  configuredProviders() {
    return this.providers.filter((p) => p.isConfigured());
  }

  /** Is ANY provider configured at all? Drives the "Real TTS not configured" banner. */
  anyProviderConfigured() {
    return this.configuredProviders().length > 0;
  }

  /**
   * Pick the best configured provider that actually supports langCode.
   * preferredId lets a caller (or future per-character setting) request a
   * specific provider; falls back to the first configured+capable one.
   */
  resolve({ langCode, preferredId }) {
    const candidates = preferredId
      ? [this.getProvider(preferredId)].filter(Boolean)
      : this.providers;

    const usable = candidates.find((p) => p.isConfigured() && p.supportsLanguage(langCode));
    if (usable) return usable;

    // Distinguish "nothing configured" from "configured but language unsupported"
    // so the API can return an honest, specific error rather than a generic one.
    const configuredButUnsupported = candidates.find((p) => p.isConfigured() && !p.supportsLanguage(langCode));
    if (configuredButUnsupported) {
      throw new ProviderError(
        `No configured provider supports "${langCode}" for TTS yet.`,
        422
      );
    }
    throw new ProviderError("No TTS provider is configured on the server.", 503);
  }

  async synthesize(params) {
    const provider = this.resolve(params);
    return provider.synthesize(params);
  }
}

module.exports = { ProviderRouter };

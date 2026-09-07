/**
 * LANGUAGE / PROVIDER SUPPORT MATRIX
 * -----------------------------------------------------------------------
 * This is the single source of truth for which (language, provider) pairs
 * are ACTUALLY capable of real TTS. Nothing in the routing or UI layer is
 * allowed to synthesize a language that isn't verified `true` here.
 *
 * Verified against public provider documentation (Sept 2026):
 *
 * Azure Speech:
 *   - am-ET (Amharic)   -> am-ET-AmehaNeural (Male), am-ET-MekdesNeural (Female)  VERIFIED
 *   - en-US (English)   -> en-US-JennyNeural, en-US-GuyNeural, etc.               VERIFIED
 *   - ti-ET (Tigrinya)  -> no published Azure neural voice                       NOT SUPPORTED
 *   - om-ET (Afaan Oromo) -> no published Azure neural voice                     NOT SUPPORTED
 *
 * ElevenLabs (Eleven Multilingual v2 / Flash v2.5):
 *   - en (English)      -> supported, part of the 29-language multilingual set  VERIFIED
 *   - am, ti, om        -> NOT part of the published multilingual language list NOT SUPPORTED
 *
 * Google Gemini TTS (model: gemini-2.5-flash-preview-tts):
 *   - am-ET (Amharic)   -> Amharic ("am") is published in Gemini TTS's         VERIFIED
 *                          supported-language list. Gemini TTS auto-detects
 *                          the spoken language from the input text itself —
 *                          there is no separate language-code request field —
 *                          so "support" here means the model's published
 *                          language list includes Amharic, not that a
 *                          language parameter is sent on the wire.
 *   - en-US             -> Gemini TTS's language list also includes English,  SCOPED OUT
 *                          but this integration intentionally scopes Gemini
 *                          to Amharic only for now (per Step 7C requirements)
 *                          so English continues to route through the
 *                          already-verified Azure/ElevenLabs adapters.
 *   - ti-ET, om-ET      -> Tigrinya and Afaan Oromo are NOT in Gemini TTS's   NOT SUPPORTED
 *                          published supported-language list.
 *   - Output is raw PCM (24kHz, 16-bit, mono) — the adapter wraps this into a
 *     correct WAV header itself; it does not claim/return MP3.
 *
 * If Azure or ElevenLabs adds Tigrinya/Oromo voices in the future, or Gemini's
 * scope is widened to English, flip the flag below AFTER confirming against
 * the provider's current published docs — never flip this blind.
 */

const LANGUAGES = {
  "am-ET": {
    label: "Amharic",
    native: "አማርኛ",
    providers: {
      azure: {
        supported: true,
        voices: [
          { id: "am-ET-AmehaNeural", gender: "Male" },
          { id: "am-ET-MekdesNeural", gender: "Female" },
        ],
      },
      elevenlabs: { supported: false, reason: "Amharic is not in ElevenLabs' published multilingual TTS language list." },
      gemini: {
        supported: true,
        model: "gemini-2.5-flash-preview-tts",
        // Gemini's prebuilt voices are shared personas, not per-language
        // voices — the language spoken is driven by the input text, which
        // Gemini TTS auto-detects. These are real, documented voice names.
        voices: [
          { id: "Kore", gender: "Neutral" },
          { id: "Puck", gender: "Male" },
          { id: "Aoede", gender: "Female" },
        ],
      },
    },
  },
  "en-US": {
    label: "English",
    native: "English",
    providers: {
      azure: {
        supported: true,
        voices: [
          { id: "en-US-JennyNeural", gender: "Female" },
          { id: "en-US-GuyNeural", gender: "Male" },
          { id: "en-US-AriaNeural", gender: "Female" },
        ],
      },
      elevenlabs: { supported: true, model: "eleven_multilingual_v2" },
      gemini: {
        supported: false,
        reason: "Gemini TTS's language list includes English, but this integration intentionally scopes Gemini to Amharic only for Step 7C; English continues to route through Azure/ElevenLabs.",
      },
    },
  },
  "ti-ET": {
    label: "Tigrinya",
    native: "ትግርኛ",
    providers: {
      azure: { supported: false, reason: "No published Azure neural voice for Tigrinya (ti-ET) as of this integration." },
      elevenlabs: { supported: false, reason: "Tigrinya is not in ElevenLabs' published multilingual TTS language list." },
      gemini: { supported: false, reason: "Tigrinya is not in Gemini TTS's published supported-language list." },
    },
  },
  "om-ET": {
    label: "Afaan Oromo",
    native: "Afaan Oromoo",
    providers: {
      azure: { supported: false, reason: "No published Azure neural voice for Afaan Oromo (om-ET) as of this integration." },
      elevenlabs: { supported: false, reason: "Afaan Oromo is not in ElevenLabs' published multilingual TTS language list." },
      gemini: { supported: false, reason: "Afaan Oromo is not in Gemini TTS's published supported-language list." },
    },
  },
};

function isSupported(langCode, providerId) {
  const lang = LANGUAGES[langCode];
  if (!lang) return false;
  const p = lang.providers[providerId];
  return !!(p && p.supported);
}

function getVoicesFor(langCode, providerId) {
  const lang = LANGUAGES[langCode];
  if (!lang) return [];
  const p = lang.providers[providerId];
  if (!p || !p.supported) return [];
  return p.voices || [];
}

function listLanguages() {
  return Object.entries(LANGUAGES).map(([code, v]) => ({
    code,
    label: v.label,
    native: v.native,
    providers: Object.fromEntries(
      Object.entries(v.providers).map(([pid, p]) => [pid, { supported: !!p.supported, reason: p.reason || null }])
    ),
  }));
}

module.exports = { LANGUAGES, isSupported, getVoicesFor, listLanguages };

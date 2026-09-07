/**
 * Builds Azure-flavored SSML from a plain dialogue/narration line plus
 * voice controls, so pause markers and emotion/style intent survive the
 * trip from the Script/Voice Studio UI down to the provider request.
 */

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// AfriVoice style -> nearest Azure mstts:express-as style, where the target
// voice actually ships that style. If the voice/style pair isn't valid,
// callers should omit express-as rather than send a request Azure will reject.
const STYLE_MAP = {
  Natural: null,
  Cinematic: "narration-professional",
  News: "newscast",
  Documentary: "documentary-narration",
  Storytelling: "narration-relaxed",
  Advertisement: "advertisement_upbeat",
  Emotional: "sad",
  Calm: "calm",
  Dramatic: "angry",
};

/**
 * @param {object} params
 * @param {string} params.text - plain text, may contain literal "..." pause markers
 * @param {string} params.langCode - e.g. "am-ET"
 * @param {string} params.voiceId - e.g. "am-ET-AmehaNeural"
 * @param {number} [params.speed] - 0.5–2.0, mapped to <prosody rate>
 * @param {number} [params.pitchSemitones] - -12..12, mapped to <prosody pitch>
 * @param {string} [params.style] - AfriVoice style name
 * @param {boolean} [params.styleSupportedByVoice] - only apply express-as if true
 */
function buildSSML({ text, langCode, voiceId, speed = 1, pitchSemitones = 0, style, styleSupportedByVoice = false }) {
  const rate = `${Math.round((speed - 1) * 100)}%`;
  const pitch = `${pitchSemitones >= 0 ? "+" : ""}${pitchSemitones}st`;

  // Turn literal ellipses / blank-line pause markers into SSML breaks so
  // pause intent from the editor survives into the audio.
  const withBreaks = escapeXml(text)
    .replace(/\.\.\.+/g, '<break time="500ms"/>')
    .replace(/\n{2,}/g, '<break time="700ms"/>');

  const azureStyle = style ? STYLE_MAP[style] : null;
  const body =
    azureStyle && styleSupportedByVoice
      ? `<mstts:express-as style="${azureStyle}"><prosody rate="${rate}" pitch="${pitch}">${withBreaks}</prosody></mstts:express-as>`
      : `<prosody rate="${rate}" pitch="${pitch}">${withBreaks}</prosody>`;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${langCode}">
  <voice name="${voiceId}">${body}</voice>
</speak>`;
}

module.exports = { buildSSML, STYLE_MAP };

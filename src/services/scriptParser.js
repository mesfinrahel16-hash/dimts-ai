/**
 * Splits a raw script into ordered scenes, each containing ordered dialogue
 * lines. This mirrors the detection rules already used in the Script Studio
 * frontend (SCENE headers, "CHARACTER:" cues) so scene ordering and
 * character attribution stay consistent between preview and generation.
 */
function parseScript(raw) {
  const lines = raw.split("\n");
  const scenes = [];
  let currentScene = null;
  let currentLine = null;

  const ensureScene = () => {
    if (!currentScene) {
      currentScene = { index: scenes.length, heading: "SCENE 01", dialogue: [] };
      scenes.push(currentScene);
    }
    return currentScene;
  };

  lines.forEach((raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    if (/^SCENE\s/i.test(trimmed)) {
      currentScene = { index: scenes.length, heading: trimmed, dialogue: [] };
      scenes.push(currentScene);
      currentLine = null;
      return;
    }

    if (/^[A-Z][A-Z\s]{1,20}:$/.test(trimmed)) {
      const scene = ensureScene();
      currentLine = { character: trimmed.replace(":", "").trim(), text: [] };
      scene.dialogue.push(currentLine);
      return;
    }

    if (currentLine) {
      currentLine.text.push(trimmed);
    }
    // Lines with no active character and no scene heading are treated as
    // action/description and are not sent to TTS.
  });

  return scenes
    .filter((s) => s.dialogue.length > 0)
    .map((s) => ({
      index: s.index,
      heading: s.heading,
      dialogue: s.dialogue.map((d, i) => ({ order: i, character: d.character, text: d.text.join(" ") })),
    }));
}

module.exports = { parseScript };

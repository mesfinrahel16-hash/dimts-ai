/**
 * Combines the per-dialogue-line audio buffers generated for a single scene.
 *
 * SAFETY RULES (see Step 7B spec):
 *  - Never concatenate compressed MP3 files as if they were raw PCM.
 *  - Never write out a corrupted / mismatched WAV header.
 *  - If a safe merge can't be done for the requested format, say so
 *    explicitly instead of silently returning something broken.
 *
 * WAV: we parse each buffer's RIFF/WAVE structure, verify the PCM formats
 * match, concatenate the raw `data` chunks, and write ONE new, correct
 * RIFF header sized for the combined payload. This is a real, safe merge.
 *
 * MP3: independently-generated MP3 files cannot be safely byte-concatenated
 * (frame headers, bit-reservoir, and encoder state don't line up across
 * files) without decoding and re-encoding. That decode/re-encode pipeline
 * is NOT implemented in this step. Rather than fake it, multi-line MP3
 * scenes return only the first line's audio and flag `mergeIncomplete`
 * so the caller/UI can report it honestly. Cross-scene, full-script
 * merging (of any format) is explicitly out of scope for Step 7B — see
 * the Step 7C note in jobQueue.js and the final status report.
 */

function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a valid WAV buffer");
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + chunkSize);
    if (chunkId === "fmt ") fmt = body;
    if (chunkId === "data") data = body;
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error("WAV buffer missing fmt or data chunk");
  return {
    audioFormat: fmt.readUInt16LE(0),
    numChannels: fmt.readUInt16LE(2),
    sampleRate: fmt.readUInt32LE(4),
    bitsPerSample: fmt.readUInt16LE(14),
    data,
  };
}

function buildWavHeader(dataLength, { numChannels, sampleRate, bitsPerSample }) {
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function mergeWavBuffers(buffers) {
  const parsed = buffers.map(parseWav);
  const [first, ...rest] = parsed;
  for (const p of rest) {
    if (p.sampleRate !== first.sampleRate || p.bitsPerSample !== first.bitsPerSample || p.numChannels !== first.numChannels) {
      throw new Error("Cannot merge WAV segments with mismatched sample format");
    }
  }
  const dataParts = parsed.map((p) => p.data);
  const totalData = Buffer.concat(dataParts);
  const header = buildWavHeader(totalData.length, first);
  return Buffer.concat([header, totalData]);
}

/**
 * @param {Array<{audioBuffer: Buffer, contentType: string, format: string}>} results
 * @param {"mp3"|"wav"} format
 */
function combineDialogueBuffers(results, format) {
  if (results.length === 1) {
    return { audioBuffer: results[0].audioBuffer, contentType: results[0].contentType, format, mergeIncomplete: false };
  }

  if (format === "wav") {
    const merged = mergeWavBuffers(results.map((r) => r.audioBuffer));
    return { audioBuffer: merged, contentType: "audio/wav", format, mergeIncomplete: false };
  }

  // format === "mp3": do not fake a merge. Report it honestly.
  return {
    audioBuffer: results[0].audioBuffer,
    contentType: results[0].contentType,
    format,
    mergeIncomplete: true,
    note:
      "This scene has multiple dialogue lines. Safe MP3 merging across independently-generated files requires a decode/re-encode step that is deferred to Step 7C. Returning only the first line's audio for MP3 — request WAV format for a fully merged scene today.",
  };
}

module.exports = { combineDialogueBuffers, mergeWavBuffers, parseWav, buildWavHeader };

const { randomUUID } = require("crypto");
const { parseScript } = require("./scriptParser");

/**
 * In-memory job store. Good enough for a single backend instance / MVP;
 * swap for Redis/Postgres before running more than one server process.
 *
 * Pipeline implemented here:
 *   Script -> Scene -> Dialogue -> Voice Job -> Provider TTS request
 *   -> Audio Segment -> Job completion
 *
 * Scenes are processed strictly in order (scene.index ascending) and, within
 * a scene, dialogue lines are processed in their original order — so scene
 * ordering and character-to-voice assignment are preserved end to end.
 */
class JobQueue {
  constructor(router) {
    this.router = router;
    this.jobs = new Map();
  }

  /**
   * @param {object} input
   * @param {string} input.script - raw script text
   * @param {string} input.langCode
   * @param {object} input.characterVoices - { [characterNameUpper]: { voiceId, provider, style, speed, pitchSemitones } }
   * @param {object} input.defaultVoice - fallback { voiceId, provider, style, speed, pitchSemitones }
   * @param {string} [input.format] - "mp3" | "wav"
   */
  createJob(input) {
    const scenes = parseScript(input.script);
    if (scenes.length === 0) {
      const err = new Error("No scenes/dialogue detected in script.");
      err.status = 422;
      throw err;
    }

    const jobId = randomUUID();
    const job = {
      id: jobId,
      status: "queued", // queued -> processing -> complete | failed
      createdAt: Date.now(),
      langCode: input.langCode,
      format: input.format === "wav" ? "wav" : "mp3",
      progress: 0,
      scenes: scenes.map((s) => ({
        index: s.index,
        heading: s.heading,
        status: "waiting", // waiting -> generating -> generated | failed
        error: null,
        audioSegmentId: null,
        durationEstimateSec: s.dialogue.reduce((sum, d) => sum + Math.round(d.text.split(/\s+/).length / 2.5), 0),
        dialogue: s.dialogue,
      })),
      segments: new Map(), // audioSegmentId -> { buffer, contentType, format, sceneIndex }
      error: null,
    };

    this.jobs.set(jobId, job);
    this._process(job, input).catch((err) => {
      job.status = "failed";
      job.error = err.message || "Unknown error";
    });

    return this._publicView(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return this._publicView(job);
  }

  /** Returns the raw audio buffer for a completed scene, for download/streaming. */
  getSegmentAudio(jobId, sceneIndex) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const scene = job.scenes.find((s) => s.index === Number(sceneIndex));
    if (!scene || !scene.audioSegmentId) return null;
    return job.segments.get(scene.audioSegmentId) || null;
  }

  async _process(job, input) {
    job.status = "processing";
    const totalScenes = job.scenes.length;

    for (const scene of job.scenes) {
      scene.status = "generating";
      try {
        const buffers = [];
        for (const line of scene.dialogue) {
          const voiceCfg =
            (input.characterVoices && input.characterVoices[line.character.toUpperCase()]) || input.defaultVoice;
          if (!voiceCfg || !voiceCfg.voiceId) {
            throw new Error(`No voice assigned for character "${line.character}".`);
          }

          const result = await this.router.synthesize({
            text: line.text,
            isSSML: false,
            langCode: job.langCode,
            voiceId: voiceCfg.voiceId,
            preferredId: voiceCfg.provider,
            speed: voiceCfg.speed ?? 1,
            pitchSemitones: voiceCfg.pitchSemitones ?? 0,
            style: voiceCfg.style,
            format: job.format,
          });
          buffers.push(result);
        }

        // Per-line buffers are concatenated only when they are raw PCM WAV
        // (safe to concatenate). Compressed formats (mp3) are kept as
        // separate per-line segments merged at the player level, never
        // byte-concatenated — see audioMerge.js for the full explanation.
        const merged = require("./audioMerge").combineDialogueBuffers(buffers, job.format);

        const segmentId = randomUUID();
        job.segments.set(segmentId, merged);
        scene.audioSegmentId = segmentId;
        scene.status = "generated";
      } catch (err) {
        scene.status = "failed";
        scene.error = err.message || "Synthesis failed";
        // Fail the whole job — we never want a partially-fake "generated"
        // scene sitting next to real ones without the caller knowing.
        job.status = "failed";
        job.error = `Scene "${scene.heading}" failed: ${scene.error}`;
        return;
      }

      const generatedCount = job.scenes.filter((s) => s.status === "generated").length;
      job.progress = Math.round((generatedCount / totalScenes) * 100);
    }

    job.status = "complete";
    job.progress = 100;
  }

  _publicView(job) {
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      format: job.format,
      langCode: job.langCode,
      scenes: job.scenes.map((s) => ({
        index: s.index,
        heading: s.heading,
        status: s.status,
        error: s.error,
        durationEstimateSec: s.durationEstimateSec,
        audioUrl: s.audioSegmentId ? `/api/jobs/${job.id}/scenes/${s.index}/audio` : null,
      })),
    };
  }
}

module.exports = { JobQueue };

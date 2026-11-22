// elevenlabs/music.js
// Adapter for ElevenLabs Music API (replaces Suno Studio backend in Suno Bridge).
// https://api.elevenlabs.io/v1/music
const { fetch: _fetch } = globalThis;

const BASE = "https://api.elevenlabs.io";

function headers(apiKey) {
  const h = { "Content-Type": "application/json" };
  if (apiKey) h["xi-api-key"] = apiKey;
  return h;
}

/**
 * Generate music from a text prompt.
 * @param {object} opts
 * @param {string} opts.apiKey ElevenLabs API key
 * @param {string} opts.prompt text prompt describing the music
 * @param {number} [opts.musicLengthMs] duration in ms (3000-600000)
 * @param {string} [opts.modelId] music_v1 | music_v2 | music_v2_5
 * @param {boolean} [opts.forceInstrumental]
 * @param {string} [opts.outputFormat] e.g. mp3_44100_128
 * @returns {Promise<Buffer>} audio bytes
 */
async function compose(opts) {
  const {
    apiKey,
    prompt,
    musicLengthMs,
    modelId = "music_v1",
    forceInstrumental = false,
    outputFormat = "mp3_44100_128",
  } = opts;
  const url = `${BASE}/v1/music?output_format=${encodeURIComponent(outputFormat)}`;
  const body = { prompt, model_id: modelId };
  if (musicLengthMs) body.music_length_ms = musicLengthMs;
  if (forceInstrumental) body.force_instrumental = true;

  const res = await fetch(url, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ElevenLabs music compose failed: ${res.status} ${text}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Save generated audio to a file.
 */
const fs = require("fs");
const path = require("path");

async function composeToFile(opts, destPath) {
  const buf = await compose(opts);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return destPath;
}

module.exports = { compose, composeToFile, BASE };

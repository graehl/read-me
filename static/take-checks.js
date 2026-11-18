// Take checks: recording-quality analysis of one take, run in the browser right after Stop.
// Pure functions over Float32 samples so they also run under Node for tests.

const FRAME_SECONDS = 0.01;
const MIN_SPEECH_RUN_FRAMES = 6; // shorter bursts are taps and clicks, not speech
const SPEECH_GAP_FRAMES = 10; // bridge pauses shorter than this inside one speech run
const CLIP_LEVEL = 0.999;

export const TAKE_CHECK_LIMITS = {
  minLeadSeconds: 0.3,
  failLeadSeconds: 0.15,
  minTrailSeconds: 0.3,
  failTrailSeconds: 0.15,
  quietPeakDb: -30,
  hotPeakDb: -1,
  gatedFloorDb: -90,
  // Calibrated 2026-11-18: clean 16 kHz read speech -28.6 dB; the same clip low-passed at
  // 5 kHz -47.2, through an 8 kHz codec -74 to -81; a real band-limited phone clip -47.1.
  bandLimitedRatioDb: -40,
  minSpeechSeconds: 0.4,
};

const toDb = (x) => 20 * Math.log10(x + 1e-12);

function frameLevelsDb(samples, sampleRate) {
  const frameLen = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const levels = new Float32Array(Math.floor(samples.length / frameLen));
  for (let f = 0; f < levels.length; f++) {
    let sum = 0;
    for (let i = f * frameLen; i < (f + 1) * frameLen; i++) sum += samples[i] * samples[i];
    levels[f] = toDb(Math.sqrt(sum / frameLen));
  }
  return levels;
}

function percentile(values, p) {
  if (values.length === 0) return -120;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Speech runs: frames above threshold, small gaps bridged, short bursts dropped. */
function findSpeechRuns(levels, thresholdDb) {
  const runs = [];
  let start = -1;
  let lastAbove = -1;
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] < thresholdDb) continue;
    if (start >= 0 && f - lastAbove > SPEECH_GAP_FRAMES) {
      runs.push([start, lastAbove + 1]);
      start = -1;
    }
    if (start < 0) start = f;
    lastAbove = f;
  }
  if (start >= 0) runs.push([start, lastAbove + 1]);
  return runs.filter(([a, b]) => b - a >= MIN_SPEECH_RUN_FRAMES);
}

function fftPower(frame) {
  const n = frame.length;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const power = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

/** High band (5-7.5 kHz) energy relative to the speech band (0.3-3.4 kHz), over speech frames. */
function highBandRatioDb(samples, sampleRate, runs, frameLen) {
  if (sampleRate < 16000) return -120;
  const n = sampleRate > 24000 ? 2048 : 1024;
  const starts = [];
  for (const [a, b] of runs) {
    for (let f = a; f < b && starts.length < 400; f += 3) starts.push(f * frameLen);
  }
  const picks = starts.filter((_, i) => i % Math.ceil(starts.length / 64 || 1) === 0);
  const sum = new Float64Array(n / 2);
  const frame = new Float64Array(n);
  let used = 0;
  for (const s of picks) {
    if (s + n > samples.length) continue;
    for (let i = 0; i < n; i++) frame[i] = samples[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    const power = fftPower(frame);
    for (let k = 0; k < power.length; k++) sum[k] += power[k];
    used++;
  }
  if (used === 0) return null;
  const binHz = sampleRate / n;
  const band = (lo, hi) => {
    let e = 0;
    for (let k = Math.ceil(lo / binHz); k <= Math.floor(hi / binHz); k++) e += sum[k];
    return e / (Math.floor(hi / binHz) - Math.ceil(lo / binHz) + 1);
  };
  return 10 * Math.log10((band(5000, 7500) + 1e-20) / (band(300, 3400) + 1e-20));
}

/**
 * Analyze one take: levels, clipping, leading and trailing silence, noise gate, bandwidth.
 * Returns {metrics, findings}; each finding is {id, level: "fail"|"warn"|"ok", message}.
 */
export function analyzeTake(samples, sampleRate, limits = TAKE_CHECK_LIMITS) {
  const duration = samples.length / sampleRate;
  const frameLen = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const levels = frameLevelsDb(samples, sampleRate);
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= CLIP_LEVEL) clipped++;
  }
  const peakDb = toDb(peak);
  const floorDb = percentile(levels, 0.1);
  const loudestFrameDb = levels.length ? Math.max(...levels) : -120;
  const thresholdDb = Math.max(floorDb + 12, loudestFrameDb - 35);
  const runs = findSpeechRuns(levels, thresholdDb);
  const speechFrames = runs.reduce((n, [a, b]) => n + b - a, 0);
  const speechStart = runs.length ? runs[0][0] * FRAME_SECONDS : null;
  const speechEnd = runs.length ? runs[runs.length - 1][1] * FRAME_SECONDS : null;
  const metrics = {
    duration_s: round3(duration),
    peak_dbfs: round1(peakDb),
    clipped_samples: clipped,
    noise_floor_dbfs: round1(floorDb),
    speech_start_s: speechStart === null ? null : round3(speechStart),
    speech_end_s: speechEnd === null ? null : round3(speechEnd),
    speech_s: round3(speechFrames * FRAME_SECONDS),
    lead_silence_s: speechStart === null ? null : round3(speechStart),
    trail_silence_s: speechEnd === null ? null : round3(duration - speechEnd),
    high_band_ratio_db: null,
  };

  const findings = [];
  const add = (id, level, message) => findings.push({ id, level, message });
  if (runs.length === 0 || metrics.speech_s < limits.minSpeechSeconds) {
    add("no-speech", "fail", "No speech heard. Check the microphone and read the line aloud.");
    return { metrics, findings };
  }
  metrics.high_band_ratio_db = (() => {
    const r = highBandRatioDb(samples, sampleRate, runs, frameLen);
    return r === null ? null : round1(r);
  })();

  if (clipped > 10) add("clipping", "fail", "Too loud: the sound clipped. Move back a little or speak more softly.");
  else if (clipped > 0) add("clipping", "warn", "Slight clipping on the loudest part.");
  else if (peakDb > limits.hotPeakDb) add("hot", "warn", "Very close to clipping.");
  if (peakDb < limits.quietPeakDb) add("too-quiet", "warn", "Quite quiet. Move a little closer to the microphone.");

  if (metrics.lead_silence_s < limits.failLeadSeconds) add("lead-silence", "fail", "Speech started too soon. Wait a moment after tapping Record.");
  else if (metrics.lead_silence_s < limits.minLeadSeconds) add("lead-silence", "warn", "Short pause before speaking; leave half a second.");
  if (metrics.trail_silence_s < limits.failTrailSeconds) add("trail-silence", "fail", "Stopped too soon: the end may be cut off. Wait a moment before tapping Stop.");
  else if (metrics.trail_silence_s < limits.minTrailSeconds) add("trail-silence", "warn", "Short pause after speaking; leave half a second.");

  if (floorDb < limits.gatedFloorDb) add("gated", "warn", "The pauses are digitally silent: noise suppression may be on.");
  if (metrics.high_band_ratio_db !== null && metrics.high_band_ratio_db < limits.bandLimitedRatioDb) {
    add("band-limited", "warn", "The sound seems band-limited (Bluetooth or a voice codec?). Use the phone's own or a wired microphone.");
  }
  if (findings.length === 0) add("ok", "ok", "Recording looks good.");
  return { metrics, findings };
}

/** Worst finding level of a take: "fail" > "warn" > "ok". */
export function worstLevel(findings) {
  if (findings.some((f) => f.level === "fail")) return "fail";
  if (findings.some((f) => f.level === "warn")) return "warn";
  return "ok";
}

const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;

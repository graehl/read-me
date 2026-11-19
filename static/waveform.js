// Waveform view: a live level envelope while recording, then the take with its speech span marked.

function sizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { ctx: canvas.getContext("2d"), width, height, ratio };
}

const cssColor = (canvas, name) => getComputedStyle(canvas).getPropertyValue(name).trim();

function drawColumns(ctx, width, height, columns, color) {
  const mid = height / 2;
  ctx.fillStyle = color;
  columns.forEach(([lo, hi], x) => {
    const top = mid - hi * mid;
    ctx.fillRect(x, top, 1, Math.max(1, (hi - lo) * mid));
  });
}

/** Min/max per pixel column. */
function envelope(samples, width) {
  const per = samples.length / width;
  const columns = [];
  for (let x = 0; x < width; x++) {
    let lo = 0;
    let hi = 0;
    for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) {
      if (samples[i] < lo) lo = samples[i];
      if (samples[i] > hi) hi = samples[i];
    }
    columns.push([lo, hi]);
  }
  return columns;
}

export function clearWaveform(canvas) {
  const { ctx, width, height } = sizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = cssColor(canvas, "--wave-axis");
  ctx.fillRect(0, Math.floor(height / 2), width, 1);
}

/** Draw a finished take; `metrics` from analyzeTake marks the detected speech span. */
export function drawTake(canvas, samples, sampleRate, metrics) {
  const { ctx, width, height } = sizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const duration = samples.length / sampleRate;
  if (metrics.speech_start_s !== null) {
    const x0 = (metrics.speech_start_s / duration) * width;
    const x1 = (metrics.speech_end_s / duration) * width;
    ctx.fillStyle = cssColor(canvas, "--wave-speech-bg");
    ctx.fillRect(x0, 0, x1 - x0, height);
  }
  // Scale to the take's peak (at most 4x) so shape is visible; levels are reported as findings.
  const gain = Math.min(4, 0.9 / Math.max(1e-6, 10 ** (metrics.peak_dbfs / 20)));
  const columns = envelope(samples, width).map(([lo, hi]) => [Math.max(-1, lo * gain), Math.min(1, hi * gain)]);
  drawColumns(ctx, width, height, columns, cssColor(canvas, "--wave-ink"));
}

/** Live envelope: keeps the last `seconds` of block peaks scrolling right to left. */
export class LiveWaveform {
  constructor(canvas, seconds = 6) {
    this.canvas = canvas;
    this.seconds = seconds;
    this.peaks = [];
    this.pending = false;
  }

  reset() {
    this.peaks = [];
    this.frozen = false;
    clearWaveform(this.canvas);
  }

  /** Stop drawing, including a frame already scheduled, so a finished take can own the canvas. */
  freeze() {
    this.frozen = true;
  }

  push(block, sampleRate) {
    if (this.frozen) return;
    let lo = 0;
    let hi = 0;
    for (const s of block) {
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    this.peaks.push([lo, hi]);
    const keep = Math.ceil((this.seconds * sampleRate) / block.length);
    if (this.peaks.length > keep) this.peaks.splice(0, this.peaks.length - keep);
    this.keep = keep;
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => this.draw());
    }
  }

  draw() {
    this.pending = false;
    if (this.frozen) return;
    const { ctx, width, height } = sizeCanvas(this.canvas);
    ctx.clearRect(0, 0, width, height);
    const step = width / (this.keep || 1);
    const mid = height / 2;
    ctx.fillStyle = cssColor(this.canvas, "--wave-live");
    const offset = width - this.peaks.length * step;
    this.peaks.forEach(([lo, hi], i) => {
      const top = mid - hi * mid;
      ctx.fillRect(offset + i * step, top, Math.max(1, step - 0.5), Math.max(1, (hi - lo) * mid));
    });
    ctx.fillStyle = cssColor(this.canvas, "--wave-clip");
    if (this.peaks.some(([lo, hi]) => hi >= 0.999 || lo <= -0.999)) ctx.fillRect(0, 0, width, 2);
  }
}

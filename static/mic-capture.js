// Microphone capture: raw mono PCM with browser voice processing turned off, plus WAV encoding.
//
// Capture choices, several learned in YA's dictation capture (yepanywhere topics/streaming-speech-capture.md):
// - echoCancellation off: on Android Chromium, requesting it selects the communication capture path,
//   which processes the signal. YA enables it only because it plays audio while dictating; we never do.
// - noiseSuppression and autoGainControl off: both reshape level and timbre. Level is fixed by choosing
//   the input device and distance, not by gain control.
// - Mono by downmix: the worklet node takes an explicit single channel with "speakers" interpretation, so
//   a stereo track is averaged rather than truncated to its first channel (a proper downmix transcribed
//   better than one channel of a stereo stream).
// - Native sample rate: the browser's resampler is not used; the server resamples to 16 kHz.
// - The microphone counts as open only once real samples arrive.

const FIRST_SAMPLES_TIMEOUT_MS = 3500;
const FLUSH_TIMEOUT_MS = 2000;

function rawAudioConstraints(deviceId) {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: { ideal: 1 },
    sampleSize: { ideal: 16 },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}

/** Audio input devices; labels are available only after microphone permission is granted. */
export async function listAudioInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label }));
}

export class MicCapture {
  /** @param onBlock called with every Float32 block, recording or not (for the level meter). */
  constructor(onBlock) {
    this.onBlock = onBlock;
    this.recording = false;
    this.blocks = [];
    this.flushes = new Map();
    this.nextFlushId = 1;
  }

  async open(deviceId = null) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: rawAudioConstraints(deviceId), video: false });
    this.track = this.stream.getAudioTracks()[0];
    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule("/static/pcm-capture-worklet.js");
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    const mute = this.context.createGain();
    mute.gain.value = 0;
    source.connect(this.node).connect(mute).connect(this.context.destination);
    const firstSamples = new Promise((resolve) => (this.onFirstSamples = resolve));
    this.node.port.onmessage = (event) => this.receive(event.data);
    if (this.context.state !== "running") await this.context.resume();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("no audio arrived from the microphone")), FIRST_SAMPLES_TIMEOUT_MS),
    );
    await Promise.race([firstSamples, timeout]);
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.context?.close();
  }

  receive(message) {
    if (message.type === "block") {
      this.onFirstSamples?.();
      this.onFirstSamples = null;
      if (this.recording) this.blocks.push(message.samples);
      this.onBlock(message.samples);
    } else if (message.type === "flushed") {
      const resolve = this.flushes.get(message.id);
      this.flushes.delete(message.id);
      resolve?.(message.samples);
    }
  }

  get sampleRate() {
    return this.context.sampleRate;
  }

  /** What the browser actually applied; constraints are requests, not guarantees. */
  captureSettings() {
    const s = this.track.getSettings();
    return {
      sampleRate: this.context.sampleRate,
      trackSampleRate: s.sampleRate ?? null,
      channelCount: s.channelCount ?? null,
      echoCancellation: s.echoCancellation ?? null,
      noiseSuppression: s.noiseSuppression ?? null,
      autoGainControl: s.autoGainControl ?? null,
      deviceId: s.deviceId ?? null,
      deviceLabel: this.track.label,
    };
  }

  start() {
    this.blocks = [];
    this.recording = true;
  }

  /**
   * Stop recording; resolves with the take's samples once the worklet's partial block arrives.
   * Rejects when the worklet does not answer (a suspended or interrupted audio context).
   */
  async stop() {
    const id = this.nextFlushId++;
    let timer;
    try {
      const tail = await new Promise((resolve, reject) => {
        this.flushes.set(id, resolve);
        this.node.port.postMessage({ type: "flush", id });
        timer = setTimeout(() => reject(new Error("the microphone stopped sending audio")), FLUSH_TIMEOUT_MS);
      });
      return concatBlocks([...this.blocks, tail]);
    } finally {
      clearTimeout(timer);
      this.flushes.delete(id);
      this.recording = false;
      this.blocks = [];
    }
  }
}

function concatBlocks(blocks) {
  const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

/** Voice-processing settings the browser left on, by name. */
export function voiceProcessingLeftOn(settings) {
  return ["echoCancellation", "noiseSuppression", "autoGainControl"].filter((k) => settings[k] === true);
}

/** Encode mono Float32 samples as 16-bit PCM WAV. */
export function encodeWav16(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

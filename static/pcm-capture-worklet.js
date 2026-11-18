// PCM capture worklet: forwards mono Float32 blocks from the microphone to the page.
const BLOCK = 2048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BLOCK);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data.type === "flush") {
        const rest = this.buffer.slice(0, this.filled);
        this.filled = 0;
        this.port.postMessage({ type: "flushed", id: event.data.id, samples: rest }, [rest.buffer]);
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const n = Math.min(channel.length - offset, BLOCK - this.filled);
      this.buffer.set(channel.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === BLOCK) {
        const block = this.buffer;
        this.port.postMessage({ type: "block", samples: block }, [block.buffer]);
        this.buffer = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);

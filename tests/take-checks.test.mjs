// Take checks on synthetic takes: padded speech-like noise passes; clipped, gated and
// band-limited takes are flagged; speech span estimates never become verdicts.  Run: node --test tests/
import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTake, tailSpeechCheck, worstLevel } from "../static/take-checks.js";

const RATE = 48000;

function take({ lead = 0.5, speech = 1.5, trail = 0.5, amp = 0.3, floor = 0.001, lowpassHz = null, seed = 1 }) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const n = Math.round((lead + speech + trail) * RATE);
  const out = new Float32Array(n);
  // A cascade of eight one-pole low-passes approximates a voice codec's steep cliff.
  const poles = new Float64Array(8);
  const alpha = lowpassHz ? 1 - Math.exp((-2 * Math.PI * lowpassHz) / RATE) : 1;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const inSpeech = t >= lead && t < lead + speech;
    let x = inSpeech ? amp * rand() * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0;
    if (lowpassHz) {
      for (let p = 0; p < poles.length; p++) x = poles[p] += alpha * (x - poles[p]);
      x *= 2;
    }
    out[i] = Math.max(-1, Math.min(1, x + floor * rand()));
  }
  return out;
}

const ids = (result) => result.findings.map((f) => `${f.id}:${f.level}`);

test("a padded, moderate take passes", () => {
  const result = analyzeTake(take({}), RATE);
  assert.deepEqual(ids(result), ["ok:ok"]);
  assert.ok(Math.abs(result.metrics.lead_silence_s - 0.5) < 0.05);
  assert.ok(Math.abs(result.metrics.trail_silence_s - 0.5) < 0.05);
});

test("speech running to either edge of the take is not judged", () => {
  assert.deepEqual(ids(analyzeTake(take({ lead: 0.02, trail: 0.02 }), RATE)), ["ok:ok"]);
});

test("speech at Stop asks for more recording; a quiet tail does not", () => {
  const cutOff = take({ trail: 0.02 });
  const stillSpeaking = tailSpeechCheck(cutOff, RATE);
  assert.ok(stillSpeaking(cutOff.subarray(cutOff.length - 0.3 * RATE)));
  const padded = take({});
  assert.ok(!tailSpeechCheck(padded, RATE)(padded.subarray(padded.length - 0.3 * RATE)));
  const silent = take({ amp: 0 });
  assert.ok(!tailSpeechCheck(silent, RATE)(silent.subarray(silent.length - 0.3 * RATE)));
});

test("clipping fails", () => {
  const result = analyzeTake(take({ amp: 3 }), RATE);
  assert.equal(worstLevel(result.findings), "fail");
  assert.ok(ids(result).includes("clipping:fail"));
});

test("digital silence between words is reported as a likely gate", () => {
  assert.ok(ids(analyzeTake(take({ floor: 0 }), RATE)).includes("gated:warn"));
});

test("a low-passed take is reported as band-limited", () => {
  assert.ok(ids(analyzeTake(take({ lowpassHz: 1500, amp: 0.6 }), RATE)).includes("band-limited:warn"));
});

test("silence alone fails as no speech", () => {
  assert.deepEqual(ids(analyzeTake(take({ amp: 0 }), RATE)), ["no-speech:fail"]);
});

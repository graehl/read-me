// read-me recorder page: one reading request, one speaker, one take at a time.
// Uploads and accepts run in per-line background queues so moving to the next line never waits;
// each line's chip shows its take's status as results arrive.

import {
  acceptFailed,
  acceptStarted,
  acceptSucceeded,
  isLineKept,
  lineStatus,
  needsUploadRetry,
  newLineState,
  releasableTakes,
  uploadQueued,
} from "./line-progress.js";
import { MicCapture, encodeWav16, listAudioInputs, voiceProcessingLeftOn } from "./mic-capture.js";
import { analyzeTake, worstLevel } from "./take-checks.js";
import { LiveWaveform, clearWaveform, drawTake } from "./waveform.js";

const MAX_TAKE_SECONDS = 85; // under the server's 90 s limit
const UPLOAD_RETRY_DELAYS_MS = [2000, 5000, 10000];
const $ = (id) => document.getElementById(id);
// The speaker field's pattern attribute is the page's one copy of the server's path-safe id rule.
const speakerIdPattern = () => new RegExp(`^(?:${$("speaker-name").pattern})$`);

const app = {
  request: null,
  speaker: "",
  mic: null,
  live: null,
  lineIndex: 0,
  mode: "idle", // idle | recording | stopping | review
  lines: new Map(), // line id -> line-progress.js line state
  queues: new Map(), // line id -> tail of that line's upload/accept chain
  pendingJobs: 0,
  captureSettings: null,
  autoStopTimer: 0,
  wakeLock: null,
};

const requestId = decodeURIComponent(location.pathname.split("/")[2] || "");
const apiBase = () => `/api/requests/${encodeURIComponent(requestId)}`;
const speakerBase = () => `${apiBase()}/speakers/${encodeURIComponent(app.speaker)}`;
const currentLine = () => app.request.lines[app.lineIndex];
const lineState = (line) => app.lines.get(line.id);
const latestTake = (line) => lineState(line).takes.at(-1) ?? null;

function showFatal(message) {
  $("fatal").textContent = message;
  $("fatal").hidden = false;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

/** Run `job` after the line's earlier jobs: an accept follows its upload, and accepts land in order. */
function enqueue(line, job) {
  app.pendingJobs++;
  const run = (app.queues.get(line.id) ?? Promise.resolve()).then(job).finally(() => {
    app.pendingJobs--;
    releaseTakeAudio(lineState(line));
    renderChips();
  });
  app.queues.set(line.id, run.catch(() => {}));
  return run;
}

/** Drop superseded takes' audio once stored, so a long session does not exhaust a phone's memory. */
function releaseTakeAudio(state) {
  for (const take of releasableTakes(state)) {
    URL.revokeObjectURL(take.url);
    take.samples = take.wav = take.url = null;
  }
}

// --- uploads and acceptance ---------------------------------------------------------

async function uploadTake(line, take) {
  const report = {
    client_take_index: take.index,
    capture: take.capture,
    checks: take.analysis,
    worst_level: take.level,
  };
  const url = `${speakerBase()}/lines/${encodeURIComponent(line.id)}/takes`;
  for (let attempt = 0; ; attempt++) {
    try {
      take.upload = "uploading";
      renderChips();
      const saved = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "audio/wav", "X-Read-Me-Take": encodeURIComponent(JSON.stringify(report)) },
        body: take.wav,
      });
      take.takeId = saved.take_id;
      take.upload = "saved";
      return;
    } catch (error) {
      if (attempt >= UPLOAD_RETRY_DELAYS_MS.length) {
        take.upload = "error";
        take.uploadError = String(error.message || error);
        throw error;
      }
      await new Promise((r) => setTimeout(r, UPLOAD_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function saveTake(line, take) {
  uploadQueued(take);
  take.uploaded = enqueue(line, () => uploadTake(line, take));
}

function acceptTake(line, take, override) {
  const state = lineState(line);
  acceptStarted(state, take, override);
  enqueue(line, async () => {
    await take.uploaded;
    await fetchJson(`${speakerBase()}/lines/${encodeURIComponent(line.id)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ take_id: take.takeId, override }),
    });
    acceptSucceeded(state, take);
  }).catch((error) => {
    acceptFailed(state, take);
    $("status").textContent = `Line ${app.request.lines.indexOf(line) + 1} was not saved: ${error.message}. Tap it to retry.`;
  });
}

function retryFailedSaves(line) {
  const take = latestTake(line);
  if (!take) return;
  if (needsUploadRetry(take)) saveTake(line, take);
  if (take.accept === "error") acceptTake(line, take, take.override);
}

// --- recording ----------------------------------------------------------------------

async function startRecording() {
  if (app.mode === "recording" || app.mode === "stopping") return;
  $("player").pause();
  app.mode = "recording";
  app.live.reset();
  app.mic.start();
  app.autoStopTimer = setTimeout(stopRecording, MAX_TAKE_SECONDS * 1000);
  render();
}

async function stopRecording() {
  if (app.mode !== "recording") return;
  app.mode = "stopping";
  clearTimeout(app.autoStopTimer);
  let samples;
  try {
    samples = await app.mic.stop();
  } catch (error) {
    app.mode = "idle";
    render();
    $("status").textContent = `Recording lost: ${error.message}. Reload the page if this repeats.`;
    return;
  }
  const line = currentLine();
  const analysis = analyzeTake(samples, app.mic.sampleRate);
  const leftOn = voiceProcessingLeftOn(app.captureSettings);
  if (leftOn.length) {
    analysis.findings.push({ id: "voice-processing", level: "warn", message: `The browser kept ${leftOn.join(", ")} on.` });
  }
  const wav = encodeWav16(samples, app.mic.sampleRate);
  const state = lineState(line);
  const take = {
    index: state.takes.length + 1,
    samples,
    sampleRate: app.mic.sampleRate,
    analysis,
    level: worstLevel(analysis.findings.filter((f) => f.id !== "ok")),
    capture: app.captureSettings,
    wav,
    url: URL.createObjectURL(wav),
    upload: "queued",
    accept: null,
  };
  state.takes.push(take);
  app.mode = "review";
  saveTake(line, take);
  releaseTakeAudio(state);
  render();
}

function toggleRecording() {
  if (app.mode === "recording") stopRecording();
  else if (app.mode !== "stopping") startRecording();
}

// --- navigation ---------------------------------------------------------------------

const isAccepted = (line) => isLineKept(lineState(line));

function goToLine(index) {
  if (app.mode === "recording" || app.mode === "stopping") return;
  app.lineIndex = Math.max(0, Math.min(app.request.lines.length - 1, index));
  retryFailedSaves(currentLine());
  app.mode = latestTake(currentLine()) ? "review" : "idle";
  $("status").textContent = "";
  render();
}

function nextLineIndex() {
  const lines = app.request.lines;
  for (let step = 1; step <= lines.length; step++) {
    const i = (app.lineIndex + step) % lines.length;
    if (!isAccepted(lines[i])) return i;
  }
  return null;
}

function acceptAndAdvance(override = false) {
  const line = currentLine();
  const take = latestTake(line);
  if (app.mode === "review" && take && take.accept !== "accepted" && take.accept !== "pending") {
    if (take.level === "fail" && !override) return;
    acceptTake(line, take, override || take.level === "fail");
  }
  const next = nextLineIndex();
  if (next === null) {
    app.mode = take ? "review" : "idle";
    render();
    return;
  }
  goToLine(next);
}

// --- rendering ----------------------------------------------------------------------

const CHIP_STATUS = {
  none: ["", "not recorded"],
  recorded: ["•", "recorded, not kept"],
  saving: ["…", "saving"],
  ok: ["✓", "kept"],
  warn: ["!", "kept, with a warning"],
  fail: ["✕", "kept despite a problem"],
  error: ["⚠", "not saved; tap to retry"],
  earlier: ["✓", "kept earlier"],
};

function renderChips() {
  const nav = $("line-chips");
  if (nav.children.length !== app.request.lines.length) {
    nav.replaceChildren(
      ...app.request.lines.map((line, i) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.addEventListener("click", () => goToLine(i));
        return chip;
      }),
    );
  }
  app.request.lines.forEach((line, i) => {
    const chip = nav.children[i];
    const status = lineStatus(lineState(line));
    const [glyph, words] = CHIP_STATUS[status];
    chip.dataset.status = status;
    chip.textContent = `${i + 1}${glyph ? " " + glyph : ""}`;
    chip.setAttribute("aria-label", `Line ${i + 1}: ${words}`);
    if (i === app.lineIndex) chip.setAttribute("aria-current", "step");
    else chip.removeAttribute("aria-current");
  });
  nav.children[app.lineIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  const kept = app.request.lines.filter(isAccepted).length;
  $("progress-count").textContent = `${kept}/${app.request.lines.length} kept · ${app.speaker}`;
  $("done").hidden = kept < app.request.lines.length;
}

function renderFindings(take, line) {
  const box = $("findings");
  const state = lineState(line);
  if (app.mode === "recording" || app.mode === "stopping") {
    box.replaceChildren(textItem("Recording… tap Stop after a short pause.", "info"));
    return;
  }
  if (!take) {
    const message = state.keptTakeId ? "Recorded earlier. Record again to replace it." : "Tap Record, pause, read the line, pause, tap Stop.";
    const items = [textItem(message, "info")];
    const leftOn = voiceProcessingLeftOn(app.captureSettings);
    if (leftOn.length) items.push(textItem(`This browser kept ${leftOn.join(", ")} on; recordings may be processed.`, "warn"));
    box.replaceChildren(...items);
    return;
  }
  const items = take.analysis.findings.map((f) => textItem(f.message, f.level));
  if (take.level === "fail" && take.accept !== "accepted" && take.accept !== "pending") {
    const anyway = document.createElement("button");
    anyway.type = "button";
    anyway.className = "link";
    anyway.textContent = "Use this take anyway";
    anyway.addEventListener("click", () => acceptAndAdvance(true));
    items.push(anyway);
  }
  if (take.upload === "error") items.push(textItem(`Not saved: ${take.uploadError}`, "fail"));
  box.replaceChildren(...items);
}

function textItem(text, level) {
  const p = document.createElement("p");
  p.className = `finding ${level}`;
  p.textContent = text;
  return p;
}

function render() {
  const line = currentLine();
  const take = app.mode === "review" ? latestTake(line) : null;
  $("line-label").textContent = `Line ${app.lineIndex + 1} of ${app.request.lines.length}`;
  $("line-text").textContent = line.text;
  if (take) drawTake($("waveform"), take.samples, take.sampleRate, take.analysis.metrics);
  else if (app.mode === "idle") app.live.reset();
  $("player").src = take ? take.url : "";
  $("play").disabled = !take;
  const record = $("record");
  const capturing = app.mode === "recording" || app.mode === "stopping";
  record.textContent = capturing ? "Stop" : "Record";
  record.disabled = app.mode === "stopping";
  record.classList.toggle("recording", capturing);
  $("mic-select").disabled = capturing;
  $("retry").disabled = app.mode !== "review";
  const canKeep = app.mode === "review" && take && take.level !== "fail";
  const canSkipAhead = app.mode === "idle" && isAccepted(line);
  $("next").disabled = !(canKeep || canSkipAhead || (take && (take.accept === "accepted" || take.accept === "pending")));
  renderFindings(take, line);
  renderChips();
}

// --- setup --------------------------------------------------------------------------

async function keepScreenOn() {
  try {
    app.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    app.wakeLock = null;
  }
}

async function openMicrophone(deviceId) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("The microphone needs a secure (https) page in a current browser.");
  }
  const mic = new MicCapture((block) => {
    if (app.mode !== "review" && app.live) app.live.push(block, mic.sampleRate);
  });
  try {
    await mic.open(deviceId);
  } catch (error) {
    mic.close();
    if (!deviceId || error.name === "NotAllowedError") throw error;
    return openMicrophone(null);
  }
  app.mic?.close();
  app.mic = mic;
  app.captureSettings = mic.captureSettings();
  if (app.captureSettings.deviceId) localStorage.setItem("read-me.mic", app.captureSettings.deviceId);
}

async function fillMicPicker() {
  const inputs = await listAudioInputs();
  const select = $("mic-select");
  select.replaceChildren(
    ...inputs.map((input, i) => {
      const option = document.createElement("option");
      option.value = input.id;
      option.textContent = input.label || `Microphone ${i + 1}`;
      return option;
    }),
  );
  select.value = app.captureSettings.deviceId ?? "";
  $("mic-picker").hidden = inputs.length < 2;
}

async function switchMicrophone(deviceId) {
  if (app.mode === "recording" || app.mode === "stopping") return;
  try {
    await openMicrophone(deviceId);
    $("status").textContent = "";
  } catch (error) {
    $("status").textContent = `Could not switch microphone: ${error.message}`;
  }
  $("mic-select").value = app.captureSettings.deviceId ?? "";
  render();
}

async function startSession(speaker) {
  app.speaker = speaker;
  localStorage.setItem("read-me.speaker", speaker);
  const url = new URL(location.href);
  url.searchParams.set("speaker", speaker);
  history.replaceState(null, "", url);
  let progress;
  try {
    progress = await fetchJson(`${speakerBase()}/progress`);
  } catch (error) {
    showFatal(`Cannot load your earlier recordings: ${error.message}. Check the connection and try again.`);
    return false;
  }
  try {
    await openMicrophone(localStorage.getItem("read-me.mic"));
  } catch (error) {
    const denied = error.name === "NotAllowedError";
    showFatal(denied ? "Microphone access was refused. Allow it in the browser's site settings, then reload." : `Microphone unavailable: ${error.message}`);
    return false;
  }
  $("fatal").hidden = true;
  for (const line of app.request.lines) {
    app.lines.set(line.id, newLineState(progress.accepted[line.id] ?? null));
  }
  $("setup").hidden = true;
  $("reader").hidden = false;
  app.live = new LiveWaveform($("waveform"));
  clearWaveform($("waveform"));
  keepScreenOn();
  fillMicPicker();
  const first = app.request.lines.findIndex((line) => !progress.accepted[line.id]);
  goToLine(first < 0 ? 0 : first);
  return true;
}

function bindControls() {
  $("record").addEventListener("click", toggleRecording);
  $("mic-select").addEventListener("change", (event) => switchMicrophone(event.target.value));
  $("retry").addEventListener("click", startRecording);
  $("next").addEventListener("click", () => acceptAndAdvance(false));
  $("play").addEventListener("click", () => {
    const player = $("player");
    if (player.paused) player.play();
    else player.pause();
  });
  $("player").addEventListener("play", () => ($("play").textContent = "❚❚"));
  $("player").addEventListener("pause", () => ($("play").textContent = "▶"));
  document.addEventListener("keydown", (event) => {
    if ($("reader").hidden || event.isComposing || event.target.closest("input, textarea, select")) return;
    if (event.key === " ") {
      event.preventDefault();
      toggleRecording();
    } else if (event.key === "Enter" && !$("next").disabled) {
      event.preventDefault();
      acceptAndAdvance(false);
    } else if (event.key === "r" || event.key === "R") {
      if (app.mode === "review") startRecording();
    } else if (event.key === "ArrowRight") goToLine(app.lineIndex + 1);
    else if (event.key === "ArrowLeft") goToLine(app.lineIndex - 1);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && app.mic && (!app.wakeLock || app.wakeLock.released)) keepScreenOn();
  });
  window.addEventListener("beforeunload", (event) => {
    if (app.pendingJobs > 0) event.preventDefault();
  });
}

async function main() {
  try {
    app.request = await fetchJson(apiBase());
  } catch (error) {
    $("request-title").textContent = "read-me";
    showFatal(`Cannot load reading request ${requestId}: ${error.message}`);
    return;
  }
  document.title = `${app.request.title} · read-me`;
  $("request-title").textContent = app.request.title;
  $("line-text").lang = app.request.language;
  $("request-instructions").textContent = app.request.instructions;
  bindControls();
  const fromUrl = new URLSearchParams(location.search).get("speaker") || "";
  const remembered = localStorage.getItem("read-me.speaker") || "";
  $("speaker-name").value = speakerIdPattern().test(fromUrl) ? fromUrl : remembered;
  $("setup").hidden = false;
  $("setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("speaker-name").value.trim();
    if (!speakerIdPattern().test(name) || $("start-mic").disabled) return;
    $("start-mic").disabled = true;
    if (!(await startSession(name))) $("start-mic").disabled = false;
  });
}

main();

// read-me recorder page: one reading request, one speaker, one take at a time.
// Uploads and accepts wait in the upload outbox (browser storage) and go to the server in order in
// the background, so moving to the next line never waits; each line's chip shows its take's status
// as results arrive. When unsent audio fills the outbox's budget, Record waits for uploads.

import {
  acceptFailed,
  acceptStarted,
  acceptSucceeded,
  isLineKept,
  lineStatus,
  newLineState,
  releasableTakes,
  uploadQueued,
} from "./line-progress.js";
import { MicCapture, encodeWav24, listAudioInputs, voiceProcessingLeftOn } from "./mic-capture.js";
import { OWNER_HEADER, ownerToken } from "./owner-token.js";
import { TAIL_CHECK_SECONDS, analyzeTake, tailSpeechCheck, worstLevel } from "./take-checks.js";
import { UploadOutbox } from "./upload-outbox.js";
import { LiveWaveform, clearWaveform, drawTake } from "./waveform.js";

const MAX_TAKE_SECONDS = 85; // with pre-roll and stop extension, under the server's 90 s limit
const STOP_EXTENSION_SECONDS = 1;
/** Room a take is assumed to need before Record is allowed: a long line at 24 bits. */
const TYPICAL_TAKE_SECONDS = 15;
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
  outbox: null,
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

/** Show a blocking problem; with `openUrl`, add a link that opens it in a new tab. */
function showFatal(message, openUrl = null) {
  $("fatal").textContent = message;
  if (openUrl) {
    const link = document.createElement("a");
    link.href = openUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = openUrl;
    $("fatal").append(" ", link);
  }
  $("fatal").hidden = false;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

/** Drop superseded takes' audio once it is safe elsewhere, so a long session does not exhaust a phone's memory. */
function releaseTakeAudio(state) {
  for (const take of releasableTakes(state)) {
    URL.revokeObjectURL(take.url);
    take.samples = take.wav = take.url = null;
  }
}

// --- uploads and acceptance ---------------------------------------------------------

const lineNumber = (line) => app.request.lines.indexOf(line) + 1;

async function saveTake(line, take) {
  const state = lineState(line);
  take.key = crypto.randomUUID();
  app.outbox.listen(take.key, {
    stored(takeId) {
      take.takeId = takeId;
      take.upload = "saved";
      releaseTakeAudio(state);
      render();
    },
    accepted() {
      acceptSucceeded(state, take);
      renderChips();
    },
    refused(error) {
      if (take.upload !== "saved") {
        take.upload = "error";
        take.uploadError = error.message;
      }
      if (take.accept === "pending") acceptFailed(state, take);
      $("status").textContent = `Line ${lineNumber(line)} was not saved: ${error.message}. Record it again.`;
      render();
    },
  });
  const report = { client_take_index: take.index, capture: take.capture, checks: take.analysis, worst_level: take.level };
  const headers = {
    "Content-Type": "audio/wav",
    "X-Read-Me-Take": encodeURIComponent(JSON.stringify(report)),
    [OWNER_HEADER]: ownerToken(),
  };
  try {
    await app.outbox.addTake(take.key, `${speakerBase()}/lines/${encodeURIComponent(line.id)}/takes`, headers, take.wav);
    uploadQueued(take, app.outbox.store.durable);
  } catch (error) {
    // Browser storage refused the take (full, or private browsing): it cannot be sent later.
    take.upload = "error";
    take.uploadError = `this browser could not store it (${error.message})`;
  }
  render();
}

function acceptTake(line, take, override) {
  acceptStarted(lineState(line), take, override);
  const url = `${speakerBase()}/lines/${encodeURIComponent(line.id)}/accept`;
  app.outbox.addAccept(url, override, take.takeId ? { takeId: take.takeId, takeKey: take.key } : { takeKey: take.key });
}

/** Whether unsent audio leaves room for another take; Record waits while it does not. */
function outboxHasRoom() {
  return app.outbox.hasRoomFor(TYPICAL_TAKE_SECONDS * app.mic.sampleRate * 3);
}

function renderBacklog() {
  const { pendingTakes, pendingBytes, waiting, store } = app.outbox;
  const box = $("backlog");
  if (pendingTakes === 0) {
    box.hidden = true;
    return;
  }
  const mb = (pendingBytes / 1e6).toFixed(1);
  const parts = [`Sending ${pendingTakes} recording${pendingTakes === 1 ? "" : "s"} (${mb} MB)`];
  if (waiting) parts.push("connection problem, retrying");
  if (!outboxHasRoom()) parts.push("Record waits until more are sent");
  parts.push(store.durable ? "they resume if you leave and come back" : "keep this page open until they are sent");
  box.textContent = `${parts.join(" · ")}.`;
  box.hidden = false;
}

// --- recording ----------------------------------------------------------------------

async function startRecording() {
  if (app.mode === "recording" || app.mode === "stopping" || !outboxHasRoom()) return;
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
  render();
  let samples;
  try {
    // Speech still under way at Stop keeps recording quietly for up to a second.
    samples = await app.mic.stop({
      extendUpTo: STOP_EXTENSION_SECONDS,
      tailSeconds: TAIL_CHECK_SECONDS,
      makeTailCheck: tailSpeechCheck,
    });
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
  const wav = encodeWav24(samples, app.mic.sampleRate);
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
  error: ["⚠", "not saved; record it again"],
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
    box.replaceChildren(app.mode === "recording" ? textItem("Recording… tap Stop when you finish.", "info") : "");
    return;
  }
  if (!take) {
    const message = !outboxHasRoom()
      ? "Waiting for earlier recordings to upload before recording more."
      : state.keptTakeId
        ? "Recorded earlier. Record again to replace it."
        : "Tap Record, read the line, tap Stop.";
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
  if (take) {
    app.live.freeze();
    drawTake($("waveform"), take.samples, take.sampleRate, take.analysis.metrics);
  } else if (app.mode === "idle") app.live.reset();
  $("player").src = take ? take.url : "";
  $("play").disabled = !take;
  const record = $("record");
  const armed = app.mode === "recording";
  record.textContent = armed ? "Stop" : "Record";
  record.disabled = app.mode === "stopping" || (!armed && !outboxHasRoom());
  record.classList.toggle("recording", armed);
  $("take").classList.toggle("armed", armed);
  $("mic-select").disabled = armed || app.mode === "stopping";
  $("retry").disabled = app.mode !== "review";
  const canKeep = app.mode === "review" && take && take.level !== "fail";
  const canSkipAhead = app.mode === "idle" && isAccepted(line);
  $("next").disabled = !(canKeep || canSkipAhead || (take && (take.accept === "accepted" || take.accept === "pending")));
  renderFindings(take, line);
  renderChips();
  renderBacklog();
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

/** Re-read which take the server keeps for each line, for lines this page has not recorded. */
async function refreshProgress() {
  const progress = await fetchJson(`${speakerBase()}/progress`).catch(() => null);
  if (!progress) return;
  for (const line of app.request.lines) {
    const state = lineState(line);
    if (state.takes.length === 0) state.keptTakeId = progress.accepted[line.id] ?? null;
  }
  render();
}

async function startSession(speaker) {
  app.speaker = speaker;
  localStorage.setItem("read-me.speaker", speaker);
  const url = new URL(location.href);
  url.pathname = `/r/${encodeURIComponent(requestId)}/${encodeURIComponent(speaker)}`;
  url.searchParams.delete("speaker");
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
    if (denied && window.self !== window.top) {
      showFatal("This view cannot use the microphone. Open the recorder in its own tab:", location.href);
    } else {
      showFatal(denied ? "Microphone access was refused. Allow it in the browser's site settings, then reload." : `Microphone unavailable: ${error.message}`);
    }
    return false;
  }
  $("fatal").hidden = true;
  app.outbox = await UploadOutbox.open({ onChange: () => app.live && render() });
  // A manual cap on unsent audio, for a slow-connection test or a device short of storage.
  const cap = Number(localStorage.getItem("read-me.outbox-budget-bytes"));
  if (cap > 0) app.outbox.budgetBytes = Math.min(app.outbox.budgetBytes, cap);
  // Accepts an earlier visit left unsent count as kept now, so Next does not send the speaker back.
  const queuedAccepts = await app.outbox.queuedAcceptUrls();
  for (const line of app.request.lines) {
    const acceptUrl = `${speakerBase()}/lines/${encodeURIComponent(line.id)}/accept`;
    const queued = queuedAccepts.has(acceptUrl) ? "queued" : null;
    app.lines.set(line.id, newLineState(progress.accepted[line.id] ?? queued));
  }
  $("setup").hidden = true;
  $("guide").open = false;
  $("mic-picker").after($("guide"));
  $("reader").hidden = false;
  app.live = new LiveWaveform($("waveform"));
  clearWaveform($("waveform"));
  keepScreenOn();
  fillMicPicker();
  const first = app.request.lines.findIndex((line) => !isAccepted(line));
  goToLine(first < 0 ? 0 : first);
  if (app.outbox.pendingTakes || queuedAccepts.size) {
    app.outbox.kick();
    app.outbox.idle().then(refreshProgress);
  }
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
    if (app.outbox && !app.outbox.store.durable && app.outbox.pendingTakes > 0) event.preventDefault();
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
  $("guide-notes").replaceChildren(
    ...app.request.guide_notes.map((note) => {
      const item = document.createElement("li");
      item.textContent = note;
      return item;
    }),
  );
  bindControls();
  const fromUrl = decodeURIComponent(location.pathname.split("/")[3] || "") || new URLSearchParams(location.search).get("speaker") || "";
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

// Line progress: which take the server holds as kept for each line, and what is still being saved.
// Pure state transitions over plain objects so Node can test them.
//
// A line state is {takes, keptTakeId, pendingAccept}. keptTakeId is only ever a take the server confirmed
// as accepted (this session or an earlier one); pendingAccept is the take whose accept is in flight.
// A take is {upload: "queued"|"uploading"|"saved"|"error", accept: null|"pending"|"accepted"|"error",
// takeId, level, ...}.

export function newLineState(keptTakeId = null) {
  return { takes: [], keptTakeId, pendingAccept: null };
}

/** Kept, or on its way to being kept: Next skips the line and the header counts it. */
export function isLineKept(state) {
  return Boolean(state.keptTakeId || state.pendingAccept);
}

/** The chip status of a line: none | recorded | saving | ok | warn | fail | earlier | error. */
export function lineStatus(state) {
  const latest = state.takes.at(-1);
  if (latest && (latest.upload === "error" || latest.accept === "error")) return "error";
  if (state.pendingAccept) return "saving";
  const kept = state.takes.find((t) => t.takeId && t.takeId === state.keptTakeId);
  if (kept) return kept.level;
  if (state.keptTakeId) return "earlier";
  return latest ? "recorded" : "none";
}

export function uploadQueued(take) {
  take.upload = "queued";
}

/** Only a failed upload is resent; a queued or running one is already on its way. */
export function needsUploadRetry(take) {
  return take.upload === "error";
}

export function acceptStarted(state, take, override) {
  take.accept = "pending";
  take.override = override;
  state.pendingAccept = take;
}

export function acceptSucceeded(state, take) {
  take.accept = "accepted";
  state.keptTakeId = take.takeId;
  if (state.pendingAccept === take) state.pendingAccept = null;
}

/** The previously kept take, if any, stays kept: the server never replaced it. */
export function acceptFailed(state, take) {
  take.accept = "error";
  if (state.pendingAccept === take) state.pendingAccept = null;
}

/** Takes whose audio the page no longer needs: superseded and already stored on the server. */
export function releasableTakes(state) {
  return state.takes.slice(0, -1).filter((t) => t.upload === "saved" && t.wav);
}

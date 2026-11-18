// Line progress: a failed accept never counts as kept, and only failed uploads are resent.
import assert from "node:assert/strict";
import test from "node:test";

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
} from "../static/line-progress.js";

const savedTake = (takeId, level = "ok") => ({ takeId, level, upload: "saved", accept: null, wav: {} });

test("an accept in flight counts as kept and shows as saving", () => {
  const state = newLineState();
  const take = savedTake("t1");
  state.takes.push(take);
  acceptStarted(state, take, false);
  assert.ok(isLineKept(state));
  assert.equal(lineStatus(state), "saving");
  acceptSucceeded(state, take);
  assert.equal(lineStatus(state), "ok");
});

test("a failed accept is not kept and does not stick at saving after a re-record", () => {
  const state = newLineState();
  const first = savedTake("t1");
  state.takes.push(first);
  acceptStarted(state, first, false);
  acceptFailed(state, first);
  assert.ok(!isLineKept(state));
  assert.equal(lineStatus(state), "error");
  state.takes.push(savedTake("t2", "warn"));
  assert.equal(lineStatus(state), "recorded");
});

test("a failed accept keeps the take kept in an earlier session", () => {
  const state = newLineState("old");
  const take = savedTake("t1");
  state.takes.push(take);
  acceptStarted(state, take, false);
  acceptFailed(state, take);
  assert.ok(isLineKept(state));
  assert.equal(state.keptTakeId, "old");
});

test("only a failed upload is resent", () => {
  const take = { upload: "error" };
  assert.ok(needsUploadRetry(take));
  uploadQueued(take);
  assert.ok(!needsUploadRetry(take));
});

test("superseded stored takes release their audio; the latest and unsaved ones do not", () => {
  const state = newLineState();
  const stored = savedTake("t1");
  const unsaved = { ...savedTake(null), upload: "error" };
  const latest = savedTake("t3");
  state.takes.push(stored, unsaved, latest);
  assert.deepEqual(releasableTakes(state), [stored]);
});

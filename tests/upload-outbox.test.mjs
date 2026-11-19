// Upload outbox over an in-memory store and a scripted server: order, retry, refusal, budget.
import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore, UploadOutbox } from "../static/upload-outbox.js";

/** A fake server: `script` maps a URL to a list of responses, one used per call, last one repeating. */
function fakeServer(script) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, body: options.body });
    const queue = script[url];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === "offline") throw new TypeError("Failed to fetch");
    return { ok: next.status < 300, status: next.status, json: async () => next.body };
  };
  return { fetch, calls };
}

const blob = (bytes) => new Blob([new Uint8Array(bytes)]);
const sleep = async () => {};

test("an accept waits for its take and names the stored take id", async () => {
  const server = fakeServer({
    "/take": [{ status: 201, body: { take_id: "T1" } }],
    "/accept": [{ status: 200, body: { accepted: { "0001": "T1" } } }],
  });
  const events = [];
  const outbox = new UploadOutbox(new MemoryStore(), { fetch: server.fetch, sleep });
  outbox.listen("k1", { stored: (id) => events.push(`stored ${id}`), accepted: () => events.push("accepted") });
  await outbox.addTake("k1", "/take", {}, blob(10));
  await outbox.addAccept("/accept", false, { takeKey: "k1" });
  await outbox.idle();
  assert.deepEqual(events, ["stored T1", "accepted"]);
  assert.equal(JSON.parse(server.calls[1].body).take_id, "T1");
  assert.equal(outbox.pendingBytes, 0);
});

test("a dropped connection is retried until the take is stored", async () => {
  const server = fakeServer({ "/take": ["offline", "offline", { status: 201, body: { take_id: "T2" } }] });
  const outbox = new UploadOutbox(new MemoryStore(), { fetch: server.fetch, sleep });
  let stored = null;
  outbox.listen("k", { stored: (id) => (stored = id) });
  await outbox.addTake("k", "/take", {}, blob(5));
  await outbox.idle();
  assert.equal(stored, "T2");
  assert.equal(server.calls.length, 3);
});

test("a refused take is dropped and its accept is refused too, without blocking later takes", async () => {
  const server = fakeServer({
    "/bad": [{ status: 400, body: { error: "not a WAV" } }],
    "/good": [{ status: 201, body: { take_id: "T3" } }],
    "/accept": [{ status: 200, body: {} }],
  });
  const refused = [];
  const outbox = new UploadOutbox(new MemoryStore(), { fetch: server.fetch, sleep });
  outbox.listen("bad", { refused: (e) => refused.push(e.message) });
  await outbox.addTake("bad", "/bad", {}, blob(5));
  await outbox.addAccept("/accept", false, { takeKey: "bad" });
  await outbox.addTake("good", "/good", {}, blob(5));
  await outbox.idle();
  assert.deepEqual(refused, ["not a WAV", "its take was never stored"]);
  assert.deepEqual(
    server.calls.map((c) => c.url),
    ["/bad", "/good"],
  );
});

test("the recorder is held back once unsent audio reaches the budget", async () => {
  const script = { "/take": ["offline"] };
  const server = fakeServer(script);
  let release;
  const blocked = new Promise((resolve) => (release = resolve));
  const outbox = new UploadOutbox(new MemoryStore(), { fetch: server.fetch, sleep: () => blocked });
  outbox.budgetBytes = 25;
  await outbox.addTake("a", "/take", {}, blob(10));
  await outbox.addTake("b", "/take", {}, blob(10));
  assert.ok(!outbox.hasRoomFor(10));
  assert.ok(outbox.hasRoomFor(5));
  script["/take"] = [{ status: 201, body: { take_id: "T" } }];
  release();
  await outbox.idle();
  assert.ok(outbox.hasRoomFor(25));
});

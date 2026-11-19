// Upload outbox: takes and accepts waiting for the server, kept in IndexedDB so a slow or broken
// connection, a reload or a closed tab loses nothing. Entries go one at a time, oldest first, so an
// accept always follows its take's upload. A network failure is retried until it succeeds; a refusal
// (HTTP 4xx) is final and reported. When IndexedDB is unavailable the outbox holds entries in memory,
// with a smaller budget, and says so (`durable` is false).
//
// Entry kinds:
//   {kind: "take", key, url, headers, body: Blob, bytes}
//   {kind: "accept", url, override, takeKey, takeId}   takeId fills in once the take is stored

const DB_NAME = "read-me";
const STORE = "outbox";
const RETRY_DELAYS_MS = [2000, 5000, 10000, 30000, 60000];
/** Never hold more than this much unsent audio, however large the browser's quota. */
export const MAX_DURABLE_BYTES = 500 * 1024 * 1024;
export const MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

export class OutboxRefused extends Error {}

/** IndexedDB-backed entry store; entries get an increasing numeric `id`. */
class IdbStore {
  constructor(db) {
    this.db = db;
    this.durable = true;
  }

  static async open() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new IdbStore(db);
  }

  run(mode, action) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? request.error);
    });
  }

  add(entry) {
    return this.run("readwrite", (s) => s.add(entry));
  }
  put(entry) {
    return this.run("readwrite", (s) => s.put(entry));
  }
  delete(id) {
    return this.run("readwrite", (s) => s.delete(id));
  }
  all() {
    return this.run("readonly", (s) => s.getAll());
  }
}

/** In-memory entry store with the same interface, for browsers without IndexedDB and for tests. */
export class MemoryStore {
  constructor() {
    this.entries = new Map();
    this.nextId = 1;
    this.durable = false;
  }
  async add(entry) {
    const id = this.nextId++;
    this.entries.set(id, { ...entry, id });
    return id;
  }
  async put(entry) {
    this.entries.set(entry.id, { ...entry });
  }
  async delete(id) {
    this.entries.delete(id);
  }
  async all() {
    return [...this.entries.values()].sort((a, b) => a.id - b.id);
  }
}

export class UploadOutbox {
  /**
   * @param store IdbStore or MemoryStore
   * @param options.fetch, options.sleep injectable for tests
   * @param options.onChange called whenever the backlog or an entry's state changes
   */
  constructor(store, { fetch = globalThis.fetch.bind(globalThis), sleep = defaultSleep, onChange = () => {} } = {}) {
    this.store = store;
    this.fetch = fetch;
    this.sleep = sleep;
    this.onChange = onChange;
    this.pendingBytes = 0;
    this.pendingTakes = 0;
    this.budgetBytes = store.durable ? MAX_DURABLE_BYTES : MEMORY_BUDGET_BYTES;
    this.waiting = null; // retry delay in progress, ms
    this.listeners = new Map(); // take key -> {stored(takeId), accepted(), refused(error)}
    this.running = false;
    this.dirty = false;
  }

  /** The durable outbox when the browser allows it, else an in-memory one. */
  static async open(options) {
    let store;
    try {
      store = await IdbStore.open();
      await navigator.storage?.persist?.();
    } catch {
      store = new MemoryStore();
    }
    const outbox = new UploadOutbox(store, options);
    await outbox.restore();
    return outbox;
  }

  /** Count entries left by an earlier page and set the budget from the browser's free storage. */
  async restore() {
    for (const entry of await this.store.all()) {
      if (entry.kind === "take") {
        this.pendingBytes += entry.bytes;
        this.pendingTakes++;
      }
    }
    await this.refreshBudget();
  }

  async refreshBudget() {
    if (!this.store.durable || !navigator.storage?.estimate) return;
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    // Half of what is free, counting the backlog as reclaimable: leave the browser room to work.
    this.budgetBytes = Math.min(MAX_DURABLE_BYTES, Math.max(0, (quota - usage) / 2) + this.pendingBytes);
  }

  /** Whether another take of `bytes` fits in the budget; the recorder waits while it does not. */
  hasRoomFor(bytes) {
    return this.pendingBytes + bytes <= this.budgetBytes;
  }

  /** Queue a take upload; `key` names it for a later accept and for `listen`. */
  async addTake(key, url, headers, body) {
    await this.store.add({ kind: "take", key, url, headers, body, bytes: body.size });
    this.pendingBytes += body.size;
    this.pendingTakes++;
    this.changed();
    this.kick();
  }

  /** Queue an accept of the take queued as `takeKey`, or of an already stored `takeId`. */
  async addAccept(url, override, { takeKey = null, takeId = null }) {
    await this.store.add({ kind: "accept", url, override, takeKey, takeId });
    this.changed();
    this.kick();
  }

  /** URLs of accepts still waiting, including ones an earlier page left. */
  async queuedAcceptUrls() {
    return new Set((await this.store.all()).filter((e) => e.kind === "accept").map((e) => e.url));
  }

  listen(key, handlers) {
    this.listeners.set(key, handlers);
  }

  /** Process entries until none remain; safe to call repeatedly, since a running drain sees new entries. */
  kick() {
    this.dirty = true;
    if (this.running) return;
    this.running = true;
    this.runs = (async () => {
      // An entry added after a drain's last look sets `dirty` again, so it is never stranded.
      while (this.dirty) {
        this.dirty = false;
        await this.drain();
      }
    })().finally(() => {
      this.running = false;
    });
  }

  /** Resolves once every queued entry has been delivered or refused. */
  async idle() {
    while (this.running) await this.runs;
  }

  async drain() {
    for (;;) {
      const [entry] = await this.store.all();
      if (!entry) return;
      await this.deliver(entry);
    }
  }

  async deliver(entry) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (entry.kind === "take") await this.deliverTake(entry);
        else await this.deliverAccept(entry);
        return;
      } catch (error) {
        if (error instanceof OutboxRefused) {
          await this.store.delete(entry.id);
          if (entry.kind === "take") this.forgetTake(entry);
          this.listeners.get(entry.key ?? entry.takeKey)?.refused?.(error);
          this.changed();
          return;
        }
        this.waiting = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        this.changed();
        await this.sleep(this.waiting);
        this.waiting = null;
      }
    }
  }

  async deliverTake(entry) {
    const { take_id: takeId } = await this.post(entry.url, entry.headers, entry.body);
    // Point waiting accepts at the stored take before forgetting the upload: a crash between the
    // two re-uploads the take (the server keeps both), but never strands an accept.
    for (const other of await this.store.all()) {
      if (other.kind === "accept" && other.takeKey === entry.key) await this.store.put({ ...other, takeId });
    }
    await this.store.delete(entry.id);
    this.forgetTake(entry);
    this.listeners.get(entry.key)?.stored?.(takeId);
    this.changed();
  }

  async deliverAccept(entry) {
    if (!entry.takeId) throw new OutboxRefused("its take was never stored");
    const body = JSON.stringify({ take_id: entry.takeId, override: entry.override });
    const progress = await this.post(entry.url, { "Content-Type": "application/json" }, body);
    await this.store.delete(entry.id);
    this.listeners.get(entry.takeKey)?.accepted?.(progress);
    this.changed();
  }

  async post(url, headers, body) {
    const response = await this.fetch(url, { method: "POST", headers, body });
    const doc = await response.json().catch(() => ({}));
    if (response.ok) return doc;
    const message = doc.error || `HTTP ${response.status}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      throw new OutboxRefused(message);
    }
    throw new Error(message);
  }

  forgetTake(entry) {
    this.pendingBytes -= entry.bytes;
    this.pendingTakes--;
  }

  changed() {
    this.onChange(this);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

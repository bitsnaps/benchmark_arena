// ── IndexedDB driver for Playground history ───────────────────────────
// Two object stores inside one database ("ba.playground"):
//   conversations — keyPath "id", index "by_updated" on updatedAt
//   meta          — keyPath "k"   (activeId, ui prefs)
// The same shape is also implemented in memory (createMemoryDriver) for
// unit tests and for the private-mode fallback, so the store never talks
// to IDB directly and every consumer can be driver-agnostic.

const DB_NAME = 'ba.playground';
const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
  });
}

export function idbSupported() {
  return typeof globalThis.indexedDB !== 'undefined' && !!globalThis.indexedDB.open;
}

export function createIdbDriver({ dbName = DB_NAME } = {}) {
  let db = null;
  let opening = null;

  function open() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const r = globalThis.indexedDB.open(dbName, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('conversations')) {
          const s = d.createObjectStore('conversations', { keyPath: 'id' });
          s.createIndex('by_updated', 'updatedAt');
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => { db = r.result; resolve(db); };
      r.onerror = () => reject(r.error || new Error('IndexedDB open failed'));
      r.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
    }).catch((e) => { opening = null; throw e; });
    return opening;
  }

  async function tx(store, mode, fn) {
    const d = await open();
    const t = d.transaction(store, mode);
    const out = await fn(t.objectStore(store));
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(out);
      t.onabort = t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));

    });
  }

  return {
    kind: 'idb',
    listConversations: () => tx('conversations', 'readonly', (s) => req(s.getAll())),
    putConversation: (c) => tx('conversations', 'readwrite', (s) => req(s.put(c))),
    deleteConversation: (id) => tx('conversations', 'readwrite', (s) => req(s.delete(id))),
    clearConversations: () => tx('conversations', 'readwrite', (s) => req(s.clear())),
    getMeta: (k) => tx('meta', 'readonly', (s) => req(s.get(k))).then((r) => (r ? r.v : null)),
    putMeta: (k, v) => tx('meta', 'readwrite', (s) => req(s.put({ k, v }))),
    async destroy() { // test/e2e reset
      if (db) { db.close(); db = null; opening = null; }
      await new Promise((resolve) => {
        const r = globalThis.indexedDB.deleteDatabase(dbName);
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      });
    },
  };
}

// Same contract, backed by a Map — unit tests and the no-IDB fallback.
export function createMemoryDriver() {
  const convs = new Map();
  const meta = new Map();
  return {
    kind: 'memory',
    listConversations: async () => [...convs.values()],
    putConversation: async (c) => { convs.set(c.id, c); },
    deleteConversation: async (id) => { convs.delete(id); },
    clearConversations: async () => { convs.clear(); },
    getMeta: async (k) => (meta.has(k) ? meta.get(k) : null),
    putMeta: async (k, v) => { meta.set(k, v); },
    async destroy() { convs.clear(); meta.clear(); },
  };
}

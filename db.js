// Small IndexedDB wrapper. Characters are stored on this device only.
const DB_NAME = "lipsync";
const STORE = "characters";

let dbPromise = null;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        Promise.resolve(fn(store)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async all() {
    const list = await tx("readonly", (s) => reqP(s.getAll()));
    return (list || []).sort((a, b) => a.name.localeCompare(b.name));
  },
  get(id) {
    return tx("readonly", (s) => reqP(s.get(id)));
  },
  put(character) {
    character.updated = Date.now();
    return tx("readwrite", (s) => reqP(s.put(character)));
  },
  remove(id) {
    return tx("readwrite", (s) => reqP(s.delete(id)));
  },
};

// Ask the browser not to evict our data under storage pressure (best effort).
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (_) {}
}

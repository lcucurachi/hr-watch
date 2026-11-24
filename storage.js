'use strict';

/* =========================================================================
   Saves the live session in the browser's built-in database (IndexedDB)
   so it survives a page reload. Nothing leaves the device.

   Layout:  meta   → { start }                    (key 'session')
            chunks → { s: [[t, hr]…], r: [[t, ms]…] } (one per save, appended)
   Appending small chunks keeps each save fast, even after hours.
   ========================================================================= */

const sessionStore = (() => {
  const DB_NAME = 'hrwatch';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) { reject(new Error('IndexedDB not available')); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('meta');
          db.createObjectStore('chunks', { autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  /** Run a transaction; resolves when it has been fully written. */
  async function run(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'chunks'], mode);
      const result = work(tx);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    /** Add new readings (arrays of [t, hr] and [t, ms]) to the saved session. */
    append(start, samples, rr) {
      return run('readwrite', (tx) => {
        tx.objectStore('meta').put({ start }, 'session');
        tx.objectStore('chunks').add({ s: samples, r: rr });
      });
    },

    /** The saved session as { start, samples: [[t, hr]…], rr: [[t, ms]…] }, or null. */
    async load() {
      const out = await run('readonly', (tx) => ({
        meta: tx.objectStore('meta').get('session'),
        chunks: tx.objectStore('chunks').getAll(),
      }));
      const meta = out.meta.result;
      if (!meta) return null;
      const samples = [];
      const rr = [];
      for (const c of out.chunks.result) {
        for (const p of c.s) samples.push(p);
        for (const r of c.r) rr.push(r);
      }
      return { start: meta.start, samples, rr };
    },

    /** Forget the saved session. */
    clear() {
      return run('readwrite', (tx) => {
        tx.objectStore('meta').clear();
        tx.objectStore('chunks').clear();
      });
    },
  };
})();

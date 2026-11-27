// Song library: every song you add is kept in this browser (IndexedDB), so it is there the next time without picking
// the files again. Nothing is uploaded; clearing the site's data in Chrome empties it.

const DB_NAME = "handdj", DB_VERSION = 1, STORE = "songs";

// A song's id: the same file added twice is one song.
export const songId = f => `${f.name}|${f.size}|${f.lastModified}`;

let opening = null;
function db() {
  return opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch(err => { opening = null; throw err; });   // a later call may try again
}

// Runs fn(store) in one transaction; resolves with fn's request result once the transaction has committed.
async function run(mode, fn) {
  const t = (await db()).transaction(STORE, mode);
  const r = fn(t.objectStore(STORE));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(r?.result);
    t.onerror = t.onabort = () => reject(t.error || new Error("library transaction failed"));
  });
}

// a stored record back as a song: { id, file, added }
const toSong = rec => ({
  id: rec.id, added: rec.added,
  file: rec.blob instanceof File ? rec.blob : new File([rec.blob], rec.name, { type: rec.type, lastModified: rec.modified }),
});

export const library = {
  // all songs, by name
  async all() {
    const recs = await run("readonly", s => s.getAll());
    return recs.map(toSong).sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
  },
  // stores the files that aren't in the library yet; returns a song for every file, in order
  async add(files) {
    const have = new Set(await run("readonly", s => s.getAllKeys()));
    const added = Date.now();
    const recs = files.map(f => ({ id: songId(f), name: f.name, type: f.type, modified: f.lastModified, added, blob: f }));
    const fresh = recs.filter(r => !have.has(r.id));
    if (fresh.length) {
      await run("readwrite", s => { for (const r of fresh) s.put(r); });
      navigator.storage?.persist?.().catch(() => {});   // ask Chrome not to clear the library when disk runs low
    }
    return files.map((file, i) => ({ id: recs[i].id, added, file }));
  },
  async remove(id) { await run("readwrite", s => s.delete(id)); },
};

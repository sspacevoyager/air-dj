// Your own pictures and sounds. They live in assets/local/, which is never committed (see assets/local/README.md),
// and are listed in assets/local/media.json. Without that file the app uses what it makes itself: a synthesized
// siren and gunshot, flat colours for the wallpaper scene, and no jungle loop.

export const LOCAL_DIR = "assets/local/";

// a path inside assets/local/, or null (no absolute paths, URLs or "..": the page only loads its own files anyway)
const localPath = p => typeof p === "string" && p && !/^[a-z]+:|^\/|(^|\/)\.\.(\/|$)/i.test(p) ? LOCAL_DIR + p : null;

// Resolves to { wallpapers: [paths], siren, pistolShot, pistolCock: path | null, jungle: { file, bpm, beats } | null }.
export const localMedia = fetch(LOCAL_DIR + "media.json", { cache: "no-store" })
  .then(r => (r.ok ? r.json() : {}))
  .catch(err => { console.warn("assets/local/media.json unreadable:", err); return {}; })
  .then(m => {
    const j = m.jungle;
    return {
      wallpapers: (Array.isArray(m.wallpapers) ? m.wallpapers : []).map(localPath).filter(Boolean),
      siren: localPath(m.siren),
      pistolShot: localPath(m.pistolShot),
      pistolCock: localPath(m.pistolCock),
      jungle: j && localPath(j.file) && j.bpm > 0 && j.beats > 0 ? { file: localPath(j.file), bpm: +j.bpm, beats: +j.beats } : null,
    };
  });

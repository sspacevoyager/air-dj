// Small helpers shared by the app and the subtitles.

// localStorage that never throws (private windows, blocked storage, full quota). set() returns whether it worked.
export const store = {
  get(key, fallback = "") { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) {
    try { if (value === null || value === "") localStorage.removeItem(key); else localStorage.setItem(key, value); return true; }
    catch { return false; }
  },
  keys(prefix) { try { return Object.keys(localStorage).filter(k => k.startsWith(prefix)); } catch { return []; } },
};

// 83.4 -> "1:23"
export const fmtTime = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

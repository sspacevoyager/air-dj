// Shared setup for the browser tests.
import fs from "node:fs";
import path from "node:path";

const ORIGIN = "http://localhost:8000";
const ROOT = path.resolve(import.meta.dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };

// Serve the repo at ORIGIN from disk (localhost counts as a secure origin, so the camera works). Returns the paths
// that weren't found, so tests can check the app has no broken references.
export async function serveApp(page) {
  const missing = [];
  await page.route(`${ORIGIN}/**`, route => {
    let p = decodeURIComponent(new URL(route.request().url()).pathname);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { missing.push(p); return route.fulfill({ status: 404, body: "not found" }); }
    route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || "application/octet-stream" });
  });
  return missing;
}

// A test song: a kick on every beat (from firstKick on) over a quiet tone, as a 16-bit mono WAV file.
export function makeSong(file, { bpm = 120, secs = 30, firstKick = 1, tone = 220 } = {}) {
  const sr = 22050, n = sr * secs, data = new Float32Array(n), beat = 60 / bpm;
  for (let t0 = firstKick; t0 < secs; t0 += beat) {
    const at = Math.round(t0 * sr);
    for (let i = 0; i < 0.2 * sr && at + i < n; i++) { const t = i / sr; data[at + i] += 0.8 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12); }
  }
  for (let i = 0; i < n; i++) data[i] += 0.08 * Math.sin(2 * Math.PI * tone * i / sr);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return file;
}

// Open the app with these songs and press Start; resolves once a song is playing.
export async function startApp(page, songs, { storage = {} } = {}) {
  await page.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  await page.goto(`${ORIGIN}/`);
  await page.setInputFiles("#files", songs);
  await page.click("#start");
  await page.waitForFunction(() => /Playing/.test(document.getElementById("now").textContent), null, { timeout: 60_000 });
}

// files a fresh checkout doesn't have, and the app does without (your own media, see assets/local/README.md)
export const OPTIONAL = ["/assets/local/media.json"];

// The app's terminal log (it is drawn on the canvas, so the tests read it from the console instead).
export function collectLogs(page) {
  const logs = [], errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => {
    if (m.type() === "debug") logs.push(m.text());
    else if (m.type() === "error" && !OPTIONAL.some(f => m.location().url.endsWith(f))) errors.push(m.text());
  });
  return { logs, errors };
}

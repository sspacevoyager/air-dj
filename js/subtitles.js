// Chinese + Russian subtitles for the loaded songs.
// 1. The decoded song is downmixed to 16 kHz mono and sent to OpenAI Whisper in overlapping ~1 minute chunks, for
//    lyric segments plus word timestamps. In one long piece Whisper tends to lose the thread on loud music and stop
//    returning lyrics after the first verse or so; short chunks keep it on track (and lift the 25 MB / ~13 min limit).
//    Each line is shown only while its words are sung: from its first word to its last, split where the singer pauses.
// 2. The segments are translated into Simplified Chinese and Russian as structured JSON by OpenAI (same key).
// 3. The result is cached in localStorage per file, so each song is only processed (and paid for) once. When the cache
//    format changes (TRANSCRIPT_V), songs are transcribed again but keep the translations of lines that didn't change.
// The OpenAI key is entered in the page, kept in this browser's localStorage, and sent only to api.openai.com.
import { store, fmtTime } from "./util.js";

const LS_OPENAI = "handdj.openaiKey", LS_CACHE = "handdj.subs.v1.";
const WHISPER_SR = 16000;                      // Whisper's own sample rate: no point sending more
const CHUNK = 60, OVERLAP = 4, PARALLEL = 3;   // s per Whisper request; s each chunk reaches into its neighbours; requests at once
const TRANSCRIPT_V = 2;                        // bump when transcription changes, so cached songs are transcribed again
// subtitle timing, in seconds of the song
const WORD_GAP = 1.5;    // a pause this long inside a line hides the line until the singing resumes
const SUB_LEAD = 0.15;   // show a line this much before its first word, so it's readable as the word lands
const SUB_HOLD = 0.6;    // keep it this long after its last word (cut short when the next line starts)
// Fixed Russian lines: a lyric line that is just this phrase (said once or repeated) always shows this Russian,
// whatever the translator returned, also for songs already cached. Chinese and other lines are untouched.
const RU_FIXED = [
  { phrase: /where(?:'s| is) your head/gi, ru: "Где твоя башка?" },
];
function fixedRu(src) {
  const text = src.replace(/[’‘`]/g, "'");
  for (const { phrase, ru } of RU_FIXED) {
    const n = (text.match(phrase) || []).length;
    if (n && !text.replace(phrase, "").replace(/[^\p{L}\p{N}]/gu, "")) return Array(n).fill(ru).join(" ");
  }
  return null;
}
// Censored on screen, in the original line and both translations, whatever the transcription or translation says
// (also for songs already cached): the N-word and its spellings, and the ways it comes out in Russian and Chinese.
// The first letter (and in English / Russian the last) stays, the rest becomes asterisks: "n***a", "н****р".
// Written to leave look-alike innocent words alone: night, Niger, Nigeria, niggle, snigger, нигде, нигилизм,
// нигерский, 尼加拉瓜 (Nicaragua), 尼加拉 (Niagara), 尼格买提 (a name). Tests: tests/unit/subtitles.test.js.
const L = String.raw`\p{L}\p{N}`;                // what counts as part of a word (any script)
const word = body => new RegExp(String.raw`(?<![${L}])(?:${body})(?![${L}])`, "giu");
const CENSOR = [
  // English: double g: nigg, nigga(h)(s/z), nigguh(s/z), nigger(s), niggah(s); digits / symbols for the i
  word(String.raw`n[i1!|íì]+gg+(?:a+h?[sz]?|uh?[sz]?|ers?)?`),
  // single g only with the slang endings (so Niger / Nigeria / nigh stay): niga(s/z), nigah, niguh
  word(String.raw`n[i1!|íì]+g(?:a+h?[sz]?|uh[sz]?)`),
  word(String.raw`nicc?a+[sz]?`),               // "nicca(s)"
  // Russian: нигга / ниггер / ниггеры..., нига(с/з), нигер (not Нигерия / нигерский), негр..., черномазый...
  word(String.raw`нигг\p{L}*|нига[сз]?|нигер(?!и|ск)\p{L}*|негр\p{L}*|черномаз\p{L}*`),
];
const CENSOR_ZH = /黑鬼|尼哥|尼格(?!买提)|尼嘎|尼加(?!拉)/g;   // the slur and its transliterations in Chinese
function censor(text) {
  if (!text) return text;
  let out = text;
  for (const re of CENSOR) out = out.replace(re, w => w.length <= 2 ? w[0] + "*" : w[0] + "*".repeat(w.length - 2) + w[w.length - 1]);
  return out.replace(CENSOR_ZH, w => w[0] + "*");
}
export { censor };

const TRANSLATE_MODEL = "gpt-4.1";

export const openaiKey = { get: () => store.get(LS_OPENAI), set: v => store.set(LS_OPENAI, v.trim()) };

const cacheKey = f => LS_CACHE + [f.name, f.size, f.lastModified].join("|");
function readCache(file) {                     // { lines, tv } or null
  try { const v = JSON.parse(store.get(cacheKey(file), "null")); return Array.isArray(v?.lines) ? { lines: v.lines, tv: v.tv || 1 } : null; }
  catch { return null; }
}
// Save a song's subtitles. localStorage holds ~5 MB: when it's full, the songs used longest ago make room.
function writeCache(key, lines) {
  const value = JSON.stringify({ lines, tv: TRANSCRIPT_V, at: Date.now() });
  if (store.set(key, value)) return;
  const age = k => { try { return JSON.parse(store.get(k, "{}")).at || 0; } catch { return 0; } };
  const old = store.keys(LS_CACHE).filter(k => k !== key).sort((a, b) => age(a) - age(b));
  for (const k of old.slice(0, Math.max(1, Math.ceil(old.length / 2)))) store.set(k, null);
  if (!store.set(key, value)) console.warn("subtitles cache is full: this song will be processed again next time");
}
// an older cache format (TRANSCRIPT_V) or lines missing a language: process the song again
const complete = c => c.tv >= TRANSCRIPT_V && c.lines.every(l => typeof l.ru === "string" && Array.isArray(l.spans));
// subtitle lines ready to show (both languages), or null if the song still needs processing
export function cachedSubs(file) {
  const c = readCache(file);
  return c && complete(c) ? c.lines : null;
}

// ---------------------------------------------------------------- 1. transcription (Whisper)
async function pcm16k(buf) {                    // the song as 16 kHz mono samples
  const sr = WHISPER_SR, ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * sr), sr);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
  return (await ctx.startRendering()).getChannelData(0);
}
function wav(pcm, sr = WHISPER_SR) {             // 16-bit mono WAV
  const v = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([v], { type: "audio/wav" });
}

// POST to the OpenAI API; a failed request throws with OpenAI's own message
async function openai(path, body, what) {
  const res = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST", body: body instanceof FormData ? body : JSON.stringify(body),
    headers: { Authorization: `Bearer ${openaiKey.get()}`, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => null))?.error?.message || res.statusText;
    throw new Error(res.status === 401 ? "OpenAI key rejected" : `${what} ${res.status}: ${msg}`);
  }
  return res.json();
}

async function whisper(blob, prompt) {
  const form = new FormData();
  form.append("file", blob, "song.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  if (prompt) form.append("prompt", prompt);
  return openai("audio/transcriptions", form, "Whisper");
}

// Whisper's hallucinations over instrumentals: confident "no speech" with low confidence in the text, or text that
// loops (high compression ratio) that Whisper itself doubts. A chorus repeated for real is repetitive too, but heard
// with confidence, so it stays.
const hallucinated = s => (s.no_speech_prob > 0.6 && s.avg_logprob < -1) || (s.compression_ratio > 2.4 && s.avg_logprob < -0.7);

// "Artist - Title (Official Video) [HD].mp3" -> a hint that helps Whisper with names and words in the lyrics
const songHint = name => {
  const t = name.replace(/\.[^.]+$/, "").replace(/[[(].*?[\])]/g, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? `Song lyrics: ${t}.` : "";
};

async function transcribe(buf, name, log) {
  const pcm = await pcm16k(buf), sr = WHISPER_SR, dur = pcm.length / sr, prompt = songHint(name);
  // chunk i covers [i*CHUNK, (i+1)*CHUNK) of the song, sent with OVERLAP seconds of context on both sides;
  // a segment belongs to the chunk its middle falls in, so the overlaps don't repeat lines
  const n = Math.max(1, Math.ceil(dur / CHUNK)), chunks = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i * CHUNK - OVERLAP), b = Math.min(dur, (i + 1) * CHUNK + OVERLAP);
    chunks.push({ off: a, from: i * CHUNK, to: i === n - 1 ? Infinity : (i + 1) * CHUNK,
                  blob: wav(pcm.subarray(Math.floor(a * sr), Math.ceil(b * sr))) });
  }
  const outs = new Array(n);
  let next = 0, done = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, n) }, async () => {
    while (!failed && next < n) {                // one part failed: don't send (and pay for) the rest
      const i = next++;
      try { outs[i] = await whisper(chunks[i].blob, prompt); } catch (err) { failed = true; throw err; }
      if (n > 1) log(`Subtitles: heard ${++done}/${n} parts of ${name}...`);
    }
  }));
  let language = "unknown", kept = 0, dropped = 0;
  const segs = [], words = [];
  outs.forEach((out, i) => {
    const { off, from, to } = chunks[i];
    if (out.language && language === "unknown") language = out.language;
    const inCore = (a, b) => { const m = off + (a + b) / 2; return m >= from && m < to; };
    for (const s of out.segments || []) {
      if (!s.text.trim() || !inCore(s.start, s.end)) continue;
      if (hallucinated(s) || /^song lyrics\b/i.test(s.text.trim())) { dropped++; continue; }   // (or the hint echoed back)
      kept++; segs.push({ start: off + s.start, end: off + s.end, text: s.text.trim() });
    }
    for (const w of out.words || []) if (w.end > w.start && inCore(w.start, w.end)) words.push({ start: off + w.start, end: off + w.end });
  });
  segs.sort((x, y) => x.start - y.start); words.sort((x, y) => x.start - y.start);
  log(`Subtitles: ${kept} lyric lines` + (dropped ? `, ${dropped} dropped as noise` : "") +
      (segs.length ? `, from ${fmtTime(segs[0].start)} to ${fmtTime(segs[segs.length - 1].end)} of ${fmtTime(dur)}` : ""));
  // Segment times are loose (they often start early and run through instrumentals); word times say when singing
  // happens. Each word belongs to the segment its middle falls in.
  return { language, segs: segs.map(s => {
    const ws = words.filter(w => { const m = (w.start + w.end) / 2; return m >= s.start && m <= s.end; });
    const spans = [];
    for (const w of ws) {
      const last = spans[spans.length - 1];
      if (last && w.start - last[1] < WORD_GAP) last[1] = w.end; else spans.push([w.start, w.end]);
    }
    if (!spans.length) spans.push([s.start, s.end]);   // no word times for this line: fall back to the segment
    return { s: spans[0][0], e: spans[spans.length - 1][1], src: s.text, spans };
  }) };
}

// ---------------------------------------------------------------- 2. translation
const TRANSLATE_SYSTEM = `You write Simplified Chinese and Russian subtitles for songs.
The user message is JSON: the song's detected language and its lyric lines as {"i", "text"}, transcribed by speech recognition, so some words may be misheard.
Translate every line into natural, idiomatic Simplified Chinese ("zh") and Russian ("ru") that keep the meaning, mood, and slang of the lyric, using the whole song as context. Keep each line short enough to read as a one-line subtitle while the music plays.
If a line is clearly not part of the song (speech-recognition artifacts such as "Thanks for watching", subtitle credits, or repeated gibberish), return empty strings for it. If a line is already Chinese or Russian, return it as is in that language (Simplified characters for Chinese) and translate it into the other.
Always translate "Where's your head?" / "Where is your head?" into Russian as "Где твоя башка?".
Never write the N-word or any racial slur in either language, even when the lyric uses it: write it censored instead, "н***а" in Russian and "黑*" in Chinese.
Return every "i" exactly once.`;

// (the last two rules are also enforced on screen by RU_FIXED and CENSOR, for songs translated before them)

const TRANSLATION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["lines"],
  properties: { lines: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["i", "zh", "ru"],
    properties: { i: { type: "integer" }, zh: { type: "string" }, ru: { type: "string" } } } } },
};

const userMessage = (language, segs) => JSON.stringify({ language, lines: segs.map((s, i) => ({ i, text: s.src })) });

// the model's {"lines": [{i, zh, ru}]} answer -> subtitle lines; lines it left empty in both languages are dropped
function applyTranslation(segs, text) {
  const out = new Map(JSON.parse(text).lines.map(l => [l.i, l]));
  return segs.map((s, i) => ({ s: s.s, e: s.e, spans: s.spans, src: s.src, zh: out.get(i)?.zh?.trim() ?? "", ru: out.get(i)?.ru?.trim() ?? "" }))
             .filter(s => s.zh || s.ru);
}

async function translate(language, segs) {
  const reply = await openai("chat/completions", {
    model: TRANSLATE_MODEL,
    messages: [{ role: "system", content: TRANSLATE_SYSTEM }, { role: "user", content: userMessage(language, segs) }],
    response_format: { type: "json_schema", json_schema: { name: "translation", strict: true, schema: TRANSLATION_SCHEMA } },
  }, "OpenAI translation");
  const choice = reply.choices?.[0];
  if (choice?.message?.refusal) throw new Error("OpenAI declined to translate this song");
  if (choice?.finish_reason === "length") throw new Error("translation was cut off (song too long)");
  if (!choice?.message?.content) throw new Error("OpenAI sent back an empty translation");
  return applyTranslation(segs, choice.message.content);
}

// ---------------------------------------------------------------- job runner
const jobs = new Map();
// The subtitle lines for a song: from the cache, or by running Whisper and the translation (one job per file at a
// time). log(text) reports progress for the terminal, onStage("translating") tells the playlist. Rejects on failure.
export function loadSubs(file, buf, { log, onStage }) {
  const cached = cachedSubs(file);
  if (cached) return Promise.resolve(cached);
  const k = cacheKey(file);
  if (!jobs.has(k)) jobs.set(k, (async () => {
    const old = readCache(file)?.lines || [];  // an older cache: its translations are reused for unchanged lines
    log(`Subtitles: transcribing ${file.name}...`);
    const { language, segs } = await transcribe(buf, file.name, log);
    if (!segs.length) { log(`Subtitles: no vocals found in ${file.name}`); writeCache(k, []); return []; }
    const known = new Map(old.filter(l => typeof l.ru === "string").map(l => [l.src, l]));
    let lines;
    if (segs.every(s => known.has(s.src))) {
      lines = segs.map(s => ({ ...s, zh: known.get(s.src).zh, ru: known.get(s.src).ru }));
    } else {
      onStage("translating");
      log(`Subtitles: translating ${segs.length} lines (${language}) to Chinese and Russian...`);
      lines = await translate(language, segs);
    }
    writeCache(k, lines);
    log(`Subtitles: ready for ${file.name} (${lines.length} lines)`);
    return lines;
  })().finally(() => jobs.delete(k)));
  return jobs.get(k);
}

// ---------------------------------------------------------------- 3. display
// The line being sung at song time t, with the window it is shown in as s / e (for the fade), or null between lines.
export function lineAt(lines, t) {
  if (!lines) return null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], next = lines[i + 1];
    const nextStart = next ? next.spans[0][0] - SUB_LEAD : Infinity;
    for (const [a, b] of l.spans) {
      const s = a - SUB_LEAD, e = Math.min(b + SUB_HOLD, Math.max(b, nextStart));
      if (t >= s && t <= e) return { ...l, s, e, src: censor(l.src), zh: censor(l.zh), ru: censor(fixedRu(l.src) ?? l.ru) };
    }
  }
  return null;
}

// Greedy wrap: CJK can break between any characters, other scripts between words.
export function wrap(g, text, maxW) {
  const tokens = /[\u3000-\u9fff\uff00-\uffef]/.test(text) ? [...text] : text.split(/(?<=\s)/);
  const rows = [""];
  for (const tk of tokens) {
    const row = rows[rows.length - 1] + tk;
    if (g.measureText(row).width > maxW && rows[rows.length - 1].trim()) rows.push(tk.trimStart());
    else rows[rows.length - 1] = row;
  }
  return rows.map(r => r.trim()).filter(Boolean);
}

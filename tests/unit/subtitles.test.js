// Unit tests for js/subtitles.js: what's shown when, the censor, the fixed Russian line, and line wrapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineAt, censor, wrap } from "../../js/subtitles.js";

const line = (src, spans, extra = {}) => ({ s: spans[0][0], e: spans.at(-1)[1], spans, src, zh: "中", ru: "ру", ...extra });

test("a line shows just before its first word and hides after its last", () => {
  const lines = [line("one", [[5, 8]])];
  assert.equal(lineAt(lines, 4.5), null);
  assert.equal(lineAt(lines, 4.9)?.src, "one");          // 0.15 s lead
  assert.equal(lineAt(lines, 8.5)?.src, "one");          // 0.6 s hold
  assert.equal(lineAt(lines, 9), null);
});

test("a pause inside a line hides it until the singing resumes", () => {
  const lines = [line("A", [[5, 8], [15, 18]])];
  assert.equal(lineAt(lines, 12), null);
  assert.equal(lineAt(lines, 15)?.src, "A");
});

test("the next line takes over instead of overlapping", () => {
  const lines = [line("A", [[5, 18]]), line("B", [[18.3, 21]])];
  assert.equal(lineAt(lines, 18.2)?.src, "B");
});

test("\"Where's your head?\" always shows the fixed Russian", () => {
  for (const src of ["Where's your head?", "Where is your head", "WHERE’S YOUR HEAD!!"])
    assert.equal(lineAt([line(src, [[0, 5]])], 1).ru, "Где твоя башка?");
  assert.equal(lineAt([line("Where's your head, where's your heart", [[0, 5]])], 1).ru, "ру");
});

test("the censor stars out the N-word and its variants", () => {
  for (const w of ["nigga", "Niggas", "NIGGAZ", "nigger", "n1gga", "niiigga", "nígga", "níga", "nicca", "нигга", "ниггеры", "негр", "黑鬼", "尼哥"])
    assert.notEqual(censor(w), w, w);
  assert.equal(censor("my niggas tonight"), "my n****s tonight");
  assert.equal(censor("Мои ниггеры"), "Мои н*****ы");
});

test("the censor leaves look-alike words alone", () => {
  for (const w of ["night", "knight", "Niger", "Nigeria", "niggle", "snigger", "enigma", "нигде", "Нигерия", "нигилизм", "нигерский",
                   "黑色", "尼加拉瓜", "尼加拉瀑布", "尼格买提", "黑奴贸易"])
    assert.equal(censor(w), w, w);
});

test("captions are censored when shown", () => {
  const l = lineAt([line("yeah nigga", [[0, 5]], { ru: "да нигга", zh: "黑鬼" })], 1);
  assert.equal(l.src, "yeah n***a"); assert.equal(l.ru, "да н***а"); assert.equal(l.zh, "黑*");
});

test("wrap breaks between words, and anywhere in Chinese", () => {
  const g = { measureText: s => ({ width: s.length * 10 }) };   // 10 px per character
  assert.deepEqual(wrap(g, "one two three four", 90), ["one two", "three", "four"]);
  assert.deepEqual(wrap(g, "当我还小的时候", 30), ["当我还", "小的时", "候"]);
});

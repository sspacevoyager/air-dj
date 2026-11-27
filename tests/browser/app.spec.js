// The app end to end in headless Chromium with a fake camera (no hands in the picture, so gestures are driven by
// their keyboard stand-ins).
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { serveApp, makeSong, startApp, collectLogs, OPTIONAL } from "./helpers.js";

test("starts and plays with no errors and no missing files", async ({ page }, info) => {
  const { errors } = collectLogs(page);
  const missing = await serveApp(page);
  await startApp(page, [makeSong(info.outputPath("song.wav"))]);
  await expect(page.locator("#status")).toContainText("Running");
  await page.waitForTimeout(2000);
  expect(missing.filter(p => p !== "/favicon.ico" && !OPTIONAL.includes(p))).toEqual([]);
  expect(errors).toEqual([]);
});

test("subtitles: transcribed and translated into Chinese and Russian (OpenAI mocked)", async ({ page }, info) => {
  await serveApp(page);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  await page.route("https://api.openai.com/**", route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = body => route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (route.request().url().includes("transcriptions"))
      return json({ language: "english", segments: [{ start: 2, end: 6, text: "Hello there", compression_ratio: 1, no_speech_prob: 0, avg_logprob: -0.2 }],
                    words: [{ word: "Hello", start: 2, end: 2.5 }, { word: "there", start: 2.6, end: 3 }] });
    return json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ lines: [{ i: 0, zh: "你好", ru: "Привет" }] }) } }] });
  });
  await startApp(page, [makeSong(info.outputPath("song.wav"))], { storage: { "handdj.openaiKey": "sk-test", "handdj.subsOn": "1" } });
  await expect(page.locator("#playlist")).toContainText("中文 + RU ✓", { timeout: 60_000 });
  const cached = await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith("handdj.subs.v1."))[1]));
  expect(cached.lines).toMatchObject([{ src: "Hello there", zh: "你好", ru: "Привет", spans: [[2, 3]] }]);
});

test("record: count-in, first track from the top, switch on the beat, save", async ({ page }, info) => {
  const { logs, errors } = collectLogs(page);
  await serveApp(page);
  const a = makeSong(info.outputPath("A.wav"), { bpm: 120 }), b = makeSong(info.outputPath("B.wav"), { bpm: 90, tone: 330 });
  await startApp(page, [a, b]);
  await page.keyboard.press("n");                                    // start the take from somewhere else on purpose
  await expect(page.locator("#now")).toContainText("2/2");
  await page.keyboard.press("Enter");                                // count-in, then the take
  await expect(page.locator("#rec")).toContainText("Stop", { timeout: 15_000 });
  await expect(page.locator("#now")).toContainText("1/2");           // back to the first track
  await page.waitForTimeout(4000);
  await page.keyboard.press("n");
  await expect.poll(() => logs.some(l => /Now playing 2\/2.*\(on the beat\)/.test(l)), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(3000);
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.keyboard.press("Enter");                                // stop
  // with WebCodecs + AAC the sync preview opens (Enter saves); without, the fallback recorder saves right away
  const preview = page.locator("#syncDlg:not([hidden])");
  if (await preview.waitFor({ timeout: 15_000 }).then(() => true, () => false)) await page.keyboard.press("Enter");
  const file = info.outputPath("take" + path.extname((await download).suggestedFilename()));
  await (await download).saveAs(file);
  expect(fs.statSync(file).size).toBeGreaterThan(100_000);
  expect(errors).toEqual([]);
});

test("library: songs and the playlist come back after a reload; search, remove, add back", async ({ page }, info) => {
  const { errors } = collectLogs(page);
  await serveApp(page);
  await page.goto("http://localhost:8000/");
  await page.setInputFiles("#files", [makeSong(info.outputPath("Alpha.wav")), makeSong(info.outputPath("Beta.wav"), { tone: 330 })]);
  await expect(page.locator("#playlist li")).toHaveCount(2);
  await page.reload();
  await expect(page.locator("#playlist li")).toHaveCount(2);         // the playlist is restored from the library
  await expect(page.locator("#library li")).toHaveCount(2);
  await expect(page.locator("#start")).toBeEnabled();
  const alpha = page.locator("#playlist li", { hasText: "Alpha" });
  await alpha.hover(); await alpha.locator(".x").click();             // ✕ shows on hover
  await expect(page.locator("#playlist li")).toHaveCount(1);
  await page.fill("#libSearch", "alp");
  await expect(page.locator("#library li")).toHaveCount(1);
  await page.locator("#library li .add").click();                     // back into the playlist
  await expect(page.locator("#playlist li")).toHaveCount(2);
  await expect(page.locator("#playlist li").last()).toContainText("Alpha");
  await page.click("#start");
  await page.waitForFunction(() => /Playing 1\/2: Beta/.test(document.getElementById("now").textContent), null, { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("a fresh checkout without your own media: synth siren and shot, no errors", async ({ page }, info) => {
  const { logs, errors } = collectLogs(page);
  await serveApp(page);
  await page.route("**/assets/local/media.json", route => route.fulfill({ status: 404, body: "not found" }));
  await startApp(page, [makeSong(info.outputPath("song.wav"))]);
  await page.mouse.move(400, 300);
  await page.keyboard.down("s"); await page.waitForTimeout(1500); await page.keyboard.up("s");   // siren
  await page.keyboard.press("4");                                    // pistol
  await page.keyboard.press("6");                                    // jungle loop: says it needs one
  await expect.poll(() => logs.some(l => /No jungle loop/.test(l))).toBe(true);
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
});

test("demo song: made in the browser, plays, tempo found, comes back after a reload", async ({ page }) => {
  const { logs, errors } = collectLogs(page);
  await serveApp(page);
  let sent = 0;                                                      // subtitles on, but the demo has nothing to send
  await page.route("https://api.openai.com/**", route => { sent++; return route.abort(); });
  await page.addInitScript(() => { localStorage.setItem("handdj.openaiKey", "sk-test"); localStorage.setItem("handdj.subsOn", "1"); });
  await page.goto("http://localhost:8000/");
  await page.click("#demo");
  await expect(page.locator("#playlist li")).toContainText("Air DJ demo", { timeout: 30_000 });
  await expect(page.locator("#playlist li")).toContainText("no vocals");
  await page.reload();
  await expect(page.locator("#playlist li")).toContainText("Air DJ demo", { timeout: 30_000 });
  await page.click("#start");
  await page.waitForFunction(() => /Playing 1\/1: Air DJ demo/.test(document.getElementById("now").textContent), null, { timeout: 60_000 });
  await expect.poll(() => logs.find(l => /Tempo: \d+ BPM/.test(l))).toMatch(/Tempo: 124 BPM/);
  await page.waitForTimeout(1000);
  expect(sent).toBe(0);
  expect(errors).toEqual([]);
});

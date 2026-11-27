// Browser tests: the real app in headless Chromium with a fake camera. The page and its files are served straight
// from this folder by tests/browser/helpers.js (no web server needed).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: {
    headless: true,
    viewport: { width: 1280, height: 1400 },
    permissions: ["camera", "microphone"],
    acceptDownloads: true,
    trace: "off",
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    },
  },
});

# Developing Air DJ

## Setup

Needs Node 22 or later (for the dev tools only; the app runs in Chrome).

```bash
npm install                          # dev tools only: ESLint and Playwright
npx playwright install chromium      # once, for the browser tests (on Linux: --with-deps chromium)
npm start                            # serves the app at http://localhost:8000 (this machine only)
```

The app itself has no build step and no runtime dependencies to install: `index.html` loads `js/app.js` as an ES
module, and third-party code is vendored in `vendor/` at pinned versions (see `THIRD_PARTY.md`).

## Pull requests

By sending a contribution you agree that it is licensed under the project's license (`LICENSE`), and that the
project's author may also license it under other terms, including commercial ones.

1. Fork, make a branch, keep the change focused on one thing.
2. `npm run lint` and `npm test` pass; for gestures and sound, also try it in Chrome with a camera.
3. Update the README tables when you add or change a gesture or key.
4. Describe what changed and how you checked it (the pull request template asks for this).

## Checks

```bash
npm run lint      # ESLint
npm test          # unit tests (node --test) + browser tests (Playwright)
```

CI runs both on every push and pull request (`.github/workflows/ci.yml`).

- `tests/unit/` test pure functions with `node --test`.
- `tests/browser/` run the real app in headless Chromium with a fake camera. The page is served from disk by
  `tests/browser/helpers.js`, test songs are generated on the fly, and OpenAI is mocked. The fake camera shows no
  hands, so gestures are driven by their keyboard stand-ins (see the Keys table in the README).
- Hand gestures, the camera and what things sound like still need a check by hand in Chrome before a release.

## How the code is organised

`js/app.js` runs top to bottom in sections marked `// ----`; the map at the top of the file lists them.

- **settings**: most tunable constants, grouped by effect (a few sit at the top of their own section). Change
  behaviour here first.
- **audio**: one Web Audio graph built in `setupAudio()`: song (held back a little so the octave voices line up),
  filter, bass boost, bitcrusher, volume, then a master soft clipper. Effects that add sound (pads, siren, gunshot) go into `padBus` / `sirenBus`.
- **effects**: one section each (drum pads, jungle loop, siren, pistol, octaves, record stop, laser eyes, throw,
  beat roll). Each has a start / update / stop trio driven from the main loop.
- **hands**: MediaPipe hand tracking at up to 30 Hz, left / right assignment, pinch / pad / pistol / fist
  detection, One Euro smoothing. Gestures land in `sides.L` / `sides.R`.
- **main loop**: `frame()` reads the hands, sets `state`, calls `applyAudio()`, draws everything, and hands the
  finished frame to the recorder.
- **recording**: WebCodecs video stamped with the audio clock, raw sound stems, the sync preview, MP4 export.

- **song library**: the playlist (`tracks`, one object per song with its decoded audio, tempo, beat grid and
  subtitles) and the library list; songs are stored by `js/library.js`.

Other files: `js/subtitles.js` (Whisper transcription, translation, timing, censoring), `js/library.js` (IndexedDB
song store), `js/demo.js` (the demo song, synthesized), `js/media.js` (your own media from `assets/local/`),
`js/util.js` (safe localStorage, time formatting), `js/gun3d.js` (3D pistol), `js/worklets/` (pitch shifter for
the octaves, and bitcrusher AudioWorklets).

Tunable values (pinch ranges, effect levels, timings) are named constants: most in the settings block at the top of
`js/app.js`, the rest at the top of their section, the subtitle timings at the top of `js/subtitles.js`.

## Adding an effect

1. Add its constants to the settings section, with a comment saying what each one does.
2. Add its code in its own `// ---- name` section: start / update / stop functions.
3. Trigger it from a gesture in `frame()` (and give it a keyboard stand-in in the keydown handler, so it can be
   tried and tested without hands).
4. Add a row to the Hands and Keys tables in the README.

## Things to know

- **Browser:** desktop Chrome. Recording uses WebCodecs with AAC; without it, it falls back to MediaRecorder.
- **API key:** the OpenAI key is stored in the browser (localStorage) and sent to OpenAI directly. That's fine for
  a personal tool on your own machine; a public deployment needs a small server that holds the key instead.
- **Media:** don't commit pictures or recordings. Personal media belongs in `assets/local/` (ignored by git); a
  sound the app needs out of the box is synthesized in code (see `synthSiren` and the pad sounds).
- **Style:** plain modern JavaScript, no framework. Keep lines under ~120 characters in new code and explain the
  why in comments, not the what.

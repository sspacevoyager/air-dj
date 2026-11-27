# Air DJ

DJ with your hands in front of a webcam: pinch for speed and filter, tap fingers for effects, record an MP4.
Runs in Chrome, nothing to install.

## Start

```bash
git clone https://github.com/sspacevoyager/air-dj.git && cd air-dj
python3 -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000 in Chrome, then:

1. **+ Add songs** (mp3, wav, m4a), or **♪ Try the demo song**.
2. **▶ Start** and allow the camera. Show your hands.
3. **Enter** records, **Enter** again stops. In the preview: **Auto sync**, then **Enter** to save.

Songs you add stay in the browser's library for next time. After updating, reload with **Cmd+Shift+R**.

## Hands

| Gesture | Left hand | Right hand |
|---|---|---|
| Pinch | speed 0.75x–1.25x | filter, muffled to open |
| Thumb on middle finger (hold) | bass boost | beat roll |
| Thumb on ring finger (hold), move up / down | 8-bit crush | octaves |
| Thumb on pinky | hi-hat | air-raid siren (hold; height = pitch) |
| Finger gun, bend the index | | pistol |

Both hands: distance = volume, raise them = echo, two fists = record stop (then swing them to throw the song
away). A face on screen sometimes gets laser eyes on a kick.

## Keys

**Enter** record · **Space** pause · **N / P** next / previous track · **1** bass · **3** hi-hat · **4** pistol ·
**6** jungle loop · **B** roll · **C** crush · **H** octaves · **S** siren (mouse height = hand height) ·
**T** record stop · **X** throw away · **E** laser eyes on / off

## Recording

- "Takes start from track 1" counts in 3-2-1 and starts the playlist with the take; N / P switch on the beat.
- The preview fixes the camera's delay: Auto sync lines the song up with your moves (clap on the beat), the slider
  fine-tunes it.
- MP4 (H.264 + AAC). Settings → Layout → Instagram 9:16 for 1080x1920. Aim for 30 fps or more (shown in the panel).

## Your own pictures and sounds

The repo ships none: the app synthesizes its siren and gunshot and uses flat colours as wallpapers. To use your own,
put them in `assets/local/` (ignored by git), as described in `assets/local/README.md`.

## Subtitles and privacy

Paste an OpenAI key in Settings to get Chinese + Russian subtitles: each song's audio goes to OpenAI once, and the
result is cached. The key stays in this browser (localStorage) and is sent only to api.openai.com. Use a key with a
spending limit. Nothing else leaves your computer: camera, songs and recordings stay local. See `SECURITY.md`.

## Development

```bash
npm install && npx playwright install chromium   # Node 22+
npm run lint && npm test
```

How the code is organised and how to contribute: `CONTRIBUTING.md`.

## License

PolyForm Noncommercial 1.0.0 (`LICENSE`): free to use, change and share for any non-commercial purpose. For
commercial use, ask the author. Vendored libraries and models keep their own licenses: `THIRD_PARTY.md`.

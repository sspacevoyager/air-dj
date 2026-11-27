# Your own pictures and sounds

Everything in this folder except this file and `media.example.json` is ignored by git, so pictures and sounds you
don't have the rights to share never end up in the repository.

1. Put your files here, for example in `wallpapers/` and `sounds/`.
2. Copy `media.example.json` to `media.json` and list them (paths are relative to this folder). Leave out what you
   don't have:

| Key | What | Without it |
|---|---|---|
| `wallpapers` | pictures for the wallpaper scene (web-sized, up to ~1920 px wide) | flat colours |
| `siren` | air-raid siren: wind-up until 3 s, steady from 3 s to past 7 s, wind-down from 7.5 s | a synthesized siren |
| `pistolShot`, `pistolCock` | the pistol's shot and the cock right after it | a synthesized shot, no cock |
| `jungle` | a drum loop (key 6): `file`, its tempo `bpm` and its length in `beats` | key 6 does nothing |

3. Reload the page (Cmd+Shift+R).

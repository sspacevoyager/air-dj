# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through GitHub: the repository's
**Security** tab, **Report a vulnerability**. Say what you found and how to reproduce it; you'll get an answer
within a week.

## What the app does with your data

- The camera picture is processed in the browser and never leaves the computer.
- Songs you add are stored in the browser (IndexedDB) and never uploaded.
- With subtitles on, each song's audio and file name go to OpenAI, using the key you pasted. The key is kept in the
  browser's localStorage and sent only to api.openai.com.
- A Content-Security-Policy in `index.html` stops the page from loading code or contacting any other server.

The server command in the README listens on this computer only (`--bind 127.0.0.1`). If you host the page, give it
its own domain: on a shared one like `<you>.github.io` every page shares one localStorage, key included.

Things that would be security bugs: anything that sends data elsewhere, runs code from a song file, file name or
camera name, or reads the key from outside the page.

# Third-party code and media

The license in `LICENSE` (PolyForm Noncommercial 1.0.0) covers this project's own code. The third-party code and models in `vendor/` keep
their own licenses, listed here.

## Code and models (in `vendor/`)

| What | Files | License |
|---|---|---|
| MediaPipe Tasks Vision 0.10.14 (hand and face tracking) | `vision_bundle.mjs`, `wasm/` | Apache 2.0, `vendor/licenses/mediapipe-LICENSE-Apache-2.0.txt` |
| MediaPipe models: hand landmarker, BlazeFace short range | `hand_landmarker.task`, `blaze_face_short_range.tflite` | Apache 2.0 (MediaPipe model cards) |
| three.js 0.170.0, bundled with the parts the 3D pistol uses | `three-pistol.mjs` | MIT, `vendor/licenses/three-LICENSE.txt` |
| mp4-muxer 5.2.2 by Vanilagy | `mp4-muxer.mjs` | MIT, `vendor/licenses/mp4-muxer-LICENSE.txt` |

## Media

The repository contains no third-party pictures or sounds. Your own go in `assets/local/`, which git ignores (see
`assets/local/README.md`).

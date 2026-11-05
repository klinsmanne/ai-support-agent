# Demo video pipeline

Rebuilds `public/demo/demo.mp4`, the 2-minute narrated demo, from the **live site**:

1. `capture.mjs`: headless Chrome (playwright-core) captures 1080p scenes of the landing page and the read-only demo dashboard, and adds caption bars.
2. `kok_tts.py`: narrates each scene with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), an open-source neural TTS that runs locally (voice `am_onyx`).
3. `build.mjs`: times each scene to its narration and assembles an H.264 MP4 with fades (ffmpeg). Normalize loudness afterwards with `loudnorm`.

Scene list, captions and narration live in `build.mjs`; ticket IDs point at real conversations in the demo tenants.

**Setup (one time, macOS):**

- `brew install ffmpeg espeak-ng python@3.12`;
- `npm i playwright-core` in this folder;
- a Python 3.12 venv `kok/` with `kokoro-onnx` and `soundfile`;
- the model files `kokoro-v1.0.onnx` and `voices-v1.0.bin` from the kokoro-onnx releases, placed here (git-ignored).

**Run:**

```bash
node build.mjs
```

# CreativeBySaiHtin Recap — Video Dubbing & Localization Workbench

Local-first Express + React/Vite studio for resumable video ingest (S0), silence/scene mapping (S3), windowed speech transcription (S1), speaker diarization & gender classification (S2), and quota-safe Gemini TTS dubbing MVP (`my-MM` and `en-US`) with ZIP + browser IndexedDB persistence.

---

## 1. Setup (macOS / Linux)

### Prerequisites
- **Node.js** 20+ and **npm**
- **FFmpeg & FFprobe** (recommended on macOS via Homebrew):
  ```bash
  brew install ffmpeg
  ```
  > If `ffmpeg` or `ffprobe` is not found on `PATH`, the server automatically falls back to `ffmpeg-static` and `ffprobe-static`.
- **Optional Python Edge TTS CLI fallback**:
  ```bash
  pip3 install edge-tts
  ```
  > At startup, the server self-tests the `edge-tts-universal` npm package (`"Hello"` with `en-US-AriaNeural`). If the npm package fails in your network/environment, the server automatically switches to spawning the Python CLI `edge-tts` (`edge-tts --voice=... --text=... --write-media=...`), or marks Edge TTS unavailable if both fail.

### Configure Environment
1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
2. Add your Google Gemini API key to `.env.local`:
   ```dotenv
   GEMINI_API_KEY="your_api_key_here"
   DATA_DIR="./data"
   PORT=3000
   ```
   The server loads `.env.local` first (then `.env`), while shell environment variables always take precedence.

---

## 2. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | *(required)* | Google Gemini API key read from `process.env.GEMINI_API_KEY` (`.env.local`, `.env`, or shell). |
| `DATA_DIR` | `./data` | Directory where projects, uploads, extracted WAVs, caches, and rendered MP4s are stored. Gitignored and never deleted at startup. |
| `PORT` | `3000` | Port where both the Express API and Vite frontend are served (`0.0.0.0:PORT`). |
| `TEXT_MODEL` | from `config.json` | Optional override for translation / glossary / gender Gemini model. |
| `TRANSCRIBE_MODEL` | from `config.json` | Optional override for S1 speech transcription Gemini model. |
| `TTS_MODEL` | from `config.json` | Optional override for Gemini TTS speech synthesis model. |
| `TTS_ENGINE` | from `config.json` | Default TTS engine (`edge` or `gemini`) configurable in the Settings & Voices UI. |
| `GAP_MS` | from `config.json` | Minimum gap margin in milliseconds used during audio slot fitting. |
| `RECAP_RATIO` | from `config.json` | Target ratio setting stored in `config.json`. |

---

## 3. How to Run

### Development (single command starts both backend & Vite frontend)
```bash
npm install && npm run dev
```
Then open [http://localhost:3000](http://localhost:3000).

### Production Build & Start
```bash
npm run build
npm start
```

### Type-Check
```bash
npm run lint
```

---

## 4. Folder Structure

```text
.
├── config.json                 # Runtime defaults: models, voice pools, rate limits, DSP thresholds
├── .env.example                # Template for .env.local
├── package.json                # npm scripts (`npm run dev`, `npm run build`, `npm start`)
├── server.ts                   # Single HTTP entrypoint: Express APIs + Vite dev middleware / dist static
├── shared/
│   └── projectTypes.ts         # Zod schemas & shared TypeScript types for API/UI
├── server/
│   ├── loadEnv.ts              # Loads .env.local and .env before server modules read process.env
│   ├── config.ts               # Config persistence, rate limiters, retry backoff, Gemini SDK clients
│   ├── logBuffer.ts            # Ring-buffer log capture exposed via /api/logs
│   ├── events/
│   │   └── sseBus.ts           # Server-Sent Events hub for live job & stage progress
│   ├── media/
│   │   ├── binaries.ts         # System PATH vs ffmpeg-static / ffprobe-static startup verification
│   │   └── ingest.ts           # Chunked upload handler + S0 probe, 16k/48k WAV extraction, 480p proxy
│   ├── analyze/
│   │   ├── cache.ts            # SHA-256 JSON cache helpers per project
│   │   ├── s1SpeechMap.ts      # Windowed Gemini transcription & segment normalization
│   │   ├── s2Speakers.ts       # Cross-window speaker merge, sample extraction & gender classification
│   │   └── s3Maps.ts           # FFmpeg silencedetect & scene-cut detection
│   ├── dub/
│   │   ├── dubPipeline.ts      # Stage 3 Dubbing MVP orchestrator (Steps A–H)
│   │   ├── translate.ts        # Glossary pass & batched syllable-budget translation
│   │   ├── syllables.ts        # Myanmar/English syllable counter & cue merging/selection
│   │   └── audioDsp.ts         # Cached Gemini TTS synthesis, atempo fit, 10% audio ducking, MP4/SRT mux
│   ├── tts/
│   │   └── ttsEngine.ts        # Edge TTS (npm + Python CLI fallback with startup self-test) & Gemini TTS
│   └── storage/
│       ├── projectStore.ts     # Atomic project.json persistence under DATA_DIR/projects/<id>
│       └── backupZip.ts        # ZIP backup export & restore logic
└── src/
    ├── App.tsx                 # App shell, health polling, browser IndexedDB recovery coordination
    ├── components/             # ProjectHub, TimelineWorkbench, DubbingStudioPanel, SettingsVoicesPanel, EnvironmentPanel, TopBar
    ├── i18n/                   # Burmese default (`my`) / English (`en`) context provider
    ├── locales/                # `my.ts` and `en.ts` UI dictionaries
    └── utils/                  # `apiClient.ts`, `chunkUploader.ts`, `indexedDbBackup.ts`, `format.ts`
```

### Runtime Project Layout (`DATA_DIR/projects/<id>/`)
```text
data/projects/p_001/
├── project.json                # Project metadata, speech segments, speakers, maps, dub cues, stage hashes
├── source/                     # Uploaded original source video & chunk upload metadata
├── work/
│   ├── audio_16k.wav           # 16 kHz mono WAV for speech recognition
│   ├── audio_48k.wav           # 48 kHz stereo WAV for audio mixing/ducking
│   ├── proxy_480p.mp4          # 480p proxy video
│   ├── samples/                # 20–30s per-speaker WAV samples
│   └── dub/clips/              # Rendered 48 kHz per-line dubbed WAV clips
├── cache/                      # Hash-keyed JSON analysis caches & cached Gemini TTS WAVs
└── out/                        # Exported dub_<lang>.mp4, .wav, .srt, and dub_dual.mp4
```

---

## 5. Known Limits

- **Stage 4 (Recap Mode) is not implemented yet**: Creating a project in Recap mode builds the 480p CFR proxy during ingest, while the dubbing pipeline covers Stage 3 (Dubbing MVP) only.
- **Edge TTS availability**: Microsoft's public Edge TTS WebSocket endpoint can be rate-limited or blocked in some environments. If both `edge-tts-universal` (npm) and the Python CLI `edge-tts` fail the startup self-test, switch to Gemini TTS in **Settings & Voices**.
- **Gemini TTS quota & spacing**: Free-tier Gemini TTS quotas are tight; the pipeline processes one TTS line at a time with configurable spacing (`GEMINI_TTS_MIN_SPACING_MS`, default `3500` ms) and caches every clip by hash. Use the **Segments to process** selector (`First N` or `Range`) for test clips before rendering a full video.
- **Disk & Backup ZIP limits**: Uploads require `3x` the video file size in free disk space under `DATA_DIR`. Backup ZIP exports uncheck the original source video by default when the file exceeds `200 MB` (including the 480p proxy instead).
- **Browser IndexedDB auto-backup cap**: Browser IndexedDB sync caches metadata, caches, TTS clips, speaker samples, and media assets up to `60 MB` per binary file. For large source videos, download the `.zip` backup or keep `DATA_DIR` on persistent disk.

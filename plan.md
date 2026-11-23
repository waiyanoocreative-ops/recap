Recap & Dubbing Studio — Full Build Specification Plan
A full-stack TypeScript video localization studio that transforms source videos (1 minute to 2 hours, spoken in any language or silent) into Burmese (my-MM), English (en-US), or dual-track productions via Recap Mode and Dubbing Mode, engineered for <= 40 ms audio-picture timing lock.

Current status
- Stage 1 (S0 ingest) — done and verified in AI Studio.
- Stage 2 (S1–S3: speech map, speakers and gender, silence and scene maps) — done and verified in AI Studio.
- Stage 3 Dubbing MVP — built in AI Studio but NOT verified. Needs a re-test locally.
- Resilient API layer (Gemini key pool from GEMINI_API_KEYS up to 5, jobs saved to DATA_DIR/jobs.json, wait and resume on network or quota errors, project backup and restore) — added by AI Studio, NOT verified.
- The project now runs locally on the Mac with Claude Code.

Known facts
- Gemini TTS free tier allows about 10 requests per day per model.
- Edge TTS did not work inside AI Studio (WebSocket timeout), so test it locally first.
- All Gemini calls go through the key pool.
- Local Gemini API calls fail with 400 FAILED_PRECONDITION "User location is not supported for the API use." — all 3 keys, direct curl and via the server. AI Studio worked because it proxies server-side. Gemini-dependent stages (transcribe, translate, Gemini TTS) need a VPN/proxy in a supported region; Edge TTS pipeline works without it.
- Phase 1 (local run and verification) is DONE: tsc/build clean, ffmpeg/ffprobe system, Edge TTS ok via python-cli fallback (npm edge-tts-universal WebSocket times out; PATH edge-tts must be >= 7.3.1 — 7.2.7 returns 403).

User Review & Critical Decisions
This plan strictly mirrors Sections 1–12 of the specification. Work proceeds one stage at a time upon user verification, in the order given by Current status and the Staged Build Plan below.
Execution Model (AI Studio Build + Local macOS): Runs React + Vite + Tailwind on the client and Node.js 20+ + Express on the server with GEMINI_API_KEY server-side only. Short clips (2–6 min) test directly in AI Studio Build; 1–2 hour features export cleanly to run locally (npm install && npm run dev with ffmpeg) to avoid Cloud Run request/disk limits.
No Browser Video Work: Browser handles only 8 MB chunked uploads, progress UI, mic/audio playback, and <video> preview/download. All ffmpeg / ffprobe / optional demucs processes run server-side via child_process.spawn.
Timing Sync vs. Lip-Sync (<= 40 ms): Targets slot-accurate timing sync (GAP_MS = 200, frame-snapped t = round(t * fps) / fps, real ffprobe duration measurement, absolute placement at round(start_ms * 48) samples). Mouth movement is not altered.
Externalized Config & Startup Discovery: Every model ID (TEXT_MODEL, TRANSCRIBE_MODEL, TTS_MODEL), GAP_MS (200), RECAP_RATIO (0.35), and per-API p-queue rate limits (geminiText, geminiTranscribe, geminiTts, edgeTts) live in config.json / environment variables and are checked against the Gemini model list at server startup—never hardcoded.
1. Overview & Core Concept
What It Does:
One Video Per Project (1 min to 2 hr, Chinese, English, any other language, or no dialogue) persisted atomically in data/projects/<id>/project.json with source/, work/, cache/, and out/ folders so every stage is idempotent and resumable across restarts.
Shared Stages (S0–S3): 8 MB resumable chunked upload (3x free disk check), ffprobe stream offset inspection (v_start_ms, a_start_ms), 16 kHz mono + 48 kHz stereo WAV extraction, 480p CFR proxy for Recap vs. untouched -c:v copy for Dubbing, <= 20 min silence-aligned diarized transcription (400 ms / 800 ms / 8 s segmentation, < 5% no-dialogue detection, optional text-only second pass), cross-window speaker identity clustering (10–15 s samples) + 20–30 s gender classification + UI merge/split/override, and FFmpeg silence (-35dB, 0.4s) & scene cut (gt(scene,0.35)) maps.
Dubbing Mode (Video Master): Glossary extraction + batched conversational translation (temperature: 0.2, zod-validated), speaker-to-voice pool mapping (female -> female, male -> male, most talkative first), Edge TTS default + optional Gemini TTS with voice calibration and a meaning-first slot fit loop (see below), BedProvider (duck default -20 dB with 80 ms/150 ms/100 ms envelope, or optional PATH-detected demucs), 10-minute Float32 windowed mixing, -c:v copy + AAC 192k muxing (mya/eng dual tracks), .srt, and report.json.
Stage 3 fit order (meaning first, no strict syllable budget): translate completely (up to 120% of the slot, joining same-speaker fragments into sentence units) -> borrow the following gap -> speed up the audio up to 1.15x -> slow the video of that unit down to 0.85x (stretch the bed equally, recompute the timeline map) -> only then retranslate shorter once.
Recap Mode (Audio Master): 2–5 min dialogue-free chapter splitting (>= 1.0 s speech gap, or >= 0.6 s silence / scene cut for silent videos, merging final < 2 min part up to 6 min), 480p proxy-informed script drafting (RECAP_RATIO = 0.35, target language only, 8–20 words or <= 60 Burmese consonant letters, tone presets, user approval gate), per-sentence TTS (hash(text, voice, rate) cached) + ffprobe duration, picture-follows-audio frame-snapped assembly (0.85x slow / <= 1 s freeze-frame last resort), loudnorm + optional music bed, per-part and merged MP4 + .srt.
2. User Experience & Visual Design
Visual Identity & Layout
Aesthetic Direction: Dark NLE workstation (#0F172A canvas, #1E293B structural surfaces, 1px hairline borders, single-elevation flat containers, zero pill badges or decorative telemetry tickers).
Typography: Outfit (headings, text-wrap: balance), DM Sans (body & single-line whitespace-nowrap controls), JetBrains Mono (tabular-nums for HH:MM:SS.mmm, slot_ms, tts_ms, and byte/quota counters).
Top Bar Contract: Strict 3-zone header — Kinetix Studio | Projects, Workbench, Environment | New Project.
Six Core UI Screens (Sections 9 & 11):
Upload: 8 MB chunk progress, 3x disk guard, pause/resume.
Analyze (Shell in Stage 1, Full S1–S3 in Stage 2): Per-stage SSE progress, media probe & WAV/proxy verification, editable transcript table, speakers table (merge/split/gender/voice).
Mode: Recap vs. Dubbing, target language (my-MM, en-US, or both).
Recap (Stage 4): Parts list (2–5 min), script editor with Approve gate, Edge/Gemini voice picker with 5s preview & speed slider, render & per-part preview.
Dubbing (Stage 3): Cue table (source, translation, slot_ms, tts_ms, green/amber/red status), per-line edit & regenerate, synchronized video + dub preview player, voice pool mapping.
Export & Reliability (Stages 3–5): Output MP4(s), .srt, report.json QA audit (<= 40 ms), live API request counters & rate-limit queue status.
3. Staged Build Plan (Section 11) & Verification (Section 12)
Phase order
1. Local run and verification — DONE (see Known facts for Gemini location block and Edge TTS version notes).
2. Verify key pool and resume (current, BLOCKED for Gemini calls by location block above): GEMINI_API_KEYS up to 5, DATA_DIR/jobs.json persistence, wait/resume on network or quota errors, project backup and restore.
3. Verify Dubbing (Stage 3): meaning-first fit loop, voice mapping, duck bed, mux, QA report.
4. UI restructure (new, no logic changes): 5-step wizard (Upload -> Analyze -> Mode -> Dub/Recap -> Export), Settings and quota status on a separate page, one primary button per screen, tables with essential columns only, works at 380 px.
5. Recap (Stage 4): chapter splitting, script approval, TTS, frame-snapped assembly, export.
6. Hardening (Stage 5): demucs, dual-language tracks, crash/restart resume, queue UI, full report.
Section 12 Acceptance Criteria (Final Benchmark)
Dubbing (2-min clip): |audio_duration - video_duration| <= 40 ms; >= 90% segments ok or compressed; zero overlapping clips; strict male->male and female->female voice mapping.
Recap (6-min clip): Every part 2–5 min (last part up to 6 min); |video_duration - narration_duration| <= 1 frame; zero cuts inside speech segments.
Dual Language (my-MM + en-US): One MP4 with mya and eng audio tracks plus individual per-language MP4 files.
Resumability & Fault Tolerance: Killing server mid-render resumes without repeating hash-cached API calls; invalid Gemini key produces a clear UI error without crashing.
4. Technical Architecture & Data Strategy (Technical Reference)
System Architecture Diagram
Code
┌───────────────────────────────────────────────────────────────────────────────┐
│ React + Vite + Tailwind Client (TypeScript) — Thin Client                     │
│ • 8MB Chunk Uploader · Progress & SSE Listener · Media Preview · Tables       │
└──────────────────────────┬───────────────────────────────┬────────────────────┘
                           │ REST + 8MB Binary Chunks      │ SSE (GET /events/:id)
                           ▼                               ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ Node.js 20+ / Express Server (TypeScript)                                     │
│ ┌────────────────────────────────────┐ ┌────────────────────────────────────┐ │
│ │ Config, Startup Checks & Queues    │ │ API Routes (Sections 4 & 11)       │ │
│ │ • config.json + env overrides      │ │ • POST /upload/chunk               │ │
│ │ • ffmpeg/ffprobe spawn check       │ │ • POST /projects/:id/analyze       │ │
│ │ • Optional demucs PATH check       │ │ • GET  /projects/:id               │ │
│ │ • ai.models.list() startup check   │ │ • PATCH /projects/:id/segments/:sid│ │
│ │ • p-queue (text/transcribe/tts/edge│ │ • POST /projects/:id/dub/render    │ │
│ │   + exponential backoff + counters)│ │ • POST /projects/:id/recap/*       │ │
│ └────────────────────────────────────┘ │ • GET /voices?lang=                │ │
│                                        └────────────────────────────────────┘ │
│ ┌────────────────────────────────────┐ ┌────────────────────────────────────┐ │
│ │ Media Engine (child_process.spawn) │ │ Data Store (Atomic JSON + Cache)   │ │
│ │ • ffprobe A/V start_time & fps     │ │ • data/projects/<id>/project.json  │ │
│ │ • 16kHz mono + 48kHz stereo WAV    │ │ • source/  work/  cache/  out/     │ │
│ │ • 480p CFR proxy (Recap only)      │ │ • SHA-256 hash-keyed API cache     │ │
│ └────────────────────────────────────┘ └────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
Canonical project.json Schema (Section 4)
id: Project identifier ("p_001", etc.)
video: { fps, duration_ms, v_start_ms, a_start_ms } (plus ingest metadata: filename, size_bytes, width, height, is_vfr, stream_offset_ms, has_audio, proxy_480p_file)
target_langs: ["my-MM"], ["en-US"], or ["my-MM", "en-US"]
speech: [{ id, start_ms, end_ms, speaker, src_lang, text }]
speakers: { [id]: { gender, voice: { engine, name } } }
silence_ms: [[start_ms, end_ms], ...]
scene_cuts_ms: [ms, ...]
dub: [{ id, start_ms, end_ms, speaker, src_text, tgt_text, slot_ms, tts_ms, tts_file, rate, status }] (ok | compressed | retranslated | overflow | needs_review)
recap: 2–5 min chapters, approved scripts, narration audio, and frame-snapped visual cuts

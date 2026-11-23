# Creativebysaihtin Recap & Dubbing Studio

Burmese/English dubbing + recap video tool (Node 20+ / Express / React / Vite / TS).
Source of truth: plan.md — follow its phase order, ONE step at a time; wait for user "continue".

## Run
- `npm run dev` — server + Vite on http://localhost:3000
- `npx tsc --noEmit` — typecheck · `npm run build` — client build

## Rules
- Always reply to the user in Burmese. Code, comments, and commit messages in English.
- Read plan.md before work; do not add features not in plan.md; ask before large refactors.
- DATA_DIR (default ./data) is never deleted at startup.
- Never print API keys; never commit .env.local. Keys live in .env.local (GEMINI_API_KEYS, max 5).
- Never read node_modules, data/, or media files. Keep answers short; no whole-file pastes.
- Commit locally after each finished step; do not push until asked.
- Edge TTS default engine; Gemini TTS free tier ≈10 req/day/model; all Gemini calls go through the key pool.

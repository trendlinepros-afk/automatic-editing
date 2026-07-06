# WickedCut

**AI-assisted video editing for Windows** — by Wicked RC LLC.

WickedCut takes one source video, runs it through a fixed, ordered editing pipeline, renders a low-res preview for human review, supports targeted revisions via a synchronized timeline + transcript, and — after final approval — generates short-form clips via the OpusClip API. It automates the tedious edit pass while keeping a human approval gate and precise manual override. It is **not** a live NLE; it is an automated pipeline with a review-and-revise loop.

---

## ⚠️ Read this first — OpusClip plan & hosting requirements

- **OpusClip API access requires a qualifying plan**: Pro Beta, Max, or Business. The API key comes from your OpusClip dashboard.
- **OpusClip is URL-in, not file-in.** It ingests a *video URL*, so WickedCut must first upload your approved final render somewhere reachable by URL. You configure an **S3-compatible bucket** (AWS S3, Cloudflare R2, Backblaze B2, MinIO, …) in *Settings → Hosting*. Shorts generation is blocked until hosting is configured.
- OpusClip constraints honored by the app: **30 requests/min** rate limit; **~10-credit (≈10 min) minimum** per clip project.

## Required API keys (Settings → API keys)

| Key | Used for | Required? |
|---|---|---|
| **Gemini** | Default AI provider for cut review, graphic planning, slot filling, revision parsing | Recommended |
| **OpenAI** | **Whisper transcription** (pinned — not routable) + optional AI provider | Yes, for real transcription/captions |
| **DeepSeek** | Optional AI provider | Optional |
| **OpusClip** | Shorts generation (post-approval) | Only for Shorts |

Keys are encrypted with Electron `safeStorage` (Windows DPAPI) and stored locally. They are never hardcoded and never sent to the renderer process. **Any missing key drops that feature into mock mode** — the whole app runs end-to-end with mock data so you can explore without credentials.

Transcription is the one metered call that scales with video length (~$0.006/min); the app shows an estimated cost before running it.

## Prerequisites

- **Windows 10/11** (the app is Windows-only; NVENC hardware encoding is used when an RTX-class GPU is present, with automatic software fallback)
- **Node.js 20+** and npm
- **FFmpeg / FFprobe** — bundled automatically via `ffmpeg-static` / `ffprobe-static` on `npm install`. If the download is blocked in your network, install FFmpeg yourself and make sure `ffmpeg`/`ffprobe` are on `PATH` (the app falls back to PATH lookup).
- **HyperFrames** — the local graphics engine (<https://github.com/heygen-com/hyperframes>). Renders the HTML/CSS template library to MP4-with-alpha via headless Chrome. Install its CLI so `hyperframes` resolves on `PATH` (e.g. `npm i -g hyperframes`). Without it, graphics render as clearly-labeled placeholder slates so the pipeline still completes.

## Setup

```bash
npm install        # installs deps + downloads ffmpeg/ffprobe + rebuilds better-sqlite3 for Electron
npm run dev        # dev mode with hot reload
npm run typecheck  # typecheck main + renderer
npm run dist       # build the Windows installer (NSIS) into release/
```

## The pipeline — strict order

1. **Cut dead space** — FFmpeg `silencedetect` (threshold dB, min duration, ~150 ms keep-pad are all tunable in Settings). Cuts are *data* at this point, nothing is trimmed yet.
2. **Review cuts** — an AI pass checks the cut list against the timed transcript for mid-word slices, meaningful pauses, over-trimming; repairs or rejects suspect cuts. Only then are cuts applied.
3. **Transitions** — FFmpeg scene detection on the *trimmed* video; transitions (crossfade / dip-to-black) at major boundaries only.
4. **Graphics** — AI plans `{timestamp, template, slots}` events from the transcript. **The plan is shown to you for approval before anything renders** (protects render time and budget). Approved graphics render via HyperFrames and composite onto the overlay track.
5. **Sound & music** — SFX placement plus background music from your local library, **auto-ducked** under speech using transcript speech regions.
6. **Preview** — fast 540p render for review. This is the review artifact, not the deliverable.

Every stage writes its decisions into the project's **EDL** (edit decision list), so any stage can re-run in isolation during revision.

## Review & revise

- The transcript is clickable and time-linked to the timeline; clicking a word seeks the preview.
- Select a timeline region **or** transcript segments, then type a natural-language instruction — *"tighten this cut"*, *"remove this graphic"*, *"the music is too loud here"*, *"add a lower-third with his name at 2:14"*. The AI maps it to one pipeline stage and re-runs **only** that stage.
- Fully manual edits work too: drag cut in/out points on the timeline, edit graphic slots, swap transitions. Manual edits and AI revisions write to the same EDL and share one **undo/redo** stack (Ctrl+Z / Ctrl+Shift+Z).
- Loop until you click **Approve final**, then export (YouTube 1080p landscape or vertical 1080×1920 presets) and optionally generate Shorts.

## Graphics template library

Six fixed HyperFrames templates, all styled from your **brand kit** (fonts — including custom `.ttf`/`.otf` — palette, logo): lower-third, title card, stat callout, numbered list, quote card, section card. The AI fills slots; it never writes freeform HTML. (A clearly-marked extension point for freeform generation exists in `src/main/graphics/templates.ts` but is intentionally not built.)

Captions are burned in at export via FFmpeg ASS rendering, styled from the same brand kit.

## Updates

*Settings → Updates → **Check for updates*** (also in the Help menu). The installed app checks GitHub Releases via `electron-updater`, downloads in the background, and offers **Restart & install**. To publish an update: bump `version` in `package.json`, build with `npm run dist`, and attach the artifacts to a GitHub Release on this repo.

## Project layout

```
src/
├── shared/          # EDL/project/IPC type model (single source of truth)
├── main/            # Electron main process
│   ├── media/       # FFmpeg wrappers: silence, scenes, cuts, mix, captions, export
│   ├── ai/          # provider routing (Gemini/OpenAI/DeepSeek/mock) + task prompts
│   ├── graphics/    # HyperFrames wrapper + fixed template library
│   ├── transcription/  # Whisper (pinned to OpenAI)
│   ├── pipeline/    # stage runner (strict order) + revision applier
│   └── shorts/      # OpusClip client + pluggable FinalVideoHost (S3 impl)
├── preload/         # typed contextBridge API
└── renderer/        # React UI: timeline+transcript centerpiece, review loop,
                     # graphics approval gate, render queue, settings
```

## Data & safety

- **Non-destructive**: source files are never modified; all intermediates live in a per-project working folder under the app's user-data directory.
- **Crash-safe**: full project state (EDL, stage decisions, revision history, brand kit) persists to a JSON project file (atomic writes) mirrored into SQLite, and reloads exactly.
- Every long operation runs in a **cancelable render queue** with visible progress.

/**
 * Zirtola shared types — the EDL (edit decision list) data model, project
 * state, pipeline stages, AI routing, and render queue contracts.
 *
 * The EDL is the single source of truth for every edit decision. Pipeline
 * stages, AI revisions, and manual edits all write here; renders only read.
 */

// ---------------------------------------------------------------------------
// Time & regions
// ---------------------------------------------------------------------------

/** Seconds from the start of the SOURCE video unless noted otherwise. */
export type Seconds = number

export interface TimeRegion {
  start: Seconds
  end: Seconds
}

// ---------------------------------------------------------------------------
// Pipeline stages — STRICT ORDER, do not reorder
// ---------------------------------------------------------------------------

export const STAGE_ORDER = [
  'cut-detect', // 1. silence detection → proposed cut list
  'cut-review', // 2. AI validates cuts against transcript, then cuts apply
  'transitions', // 3. scene detection on trimmed video → transitions
  'graphics', // 4. AI plan → user approval → HyperFrames render → composite
  'audio', // 5. SFX + music + auto-ducking mix
  'preview' // 6. low-res preview export
] as const

export type StageId = (typeof STAGE_ORDER)[number]

export type StageStatus =
  | 'pending'
  | 'running'
  | 'awaiting-approval' // graphics stage pauses here before rendering
  | 'done'
  | 'error'
  | 'stale' // upstream data changed; needs a re-run

export interface StageState {
  id: StageId
  status: StageStatus
  /** Path of the intermediate artifact this stage produced, if any. */
  artifactPath?: string
  error?: string
  startedAt?: string
  finishedAt?: string
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptWord {
  word: string
  start: Seconds
  end: Seconds
}

export interface TranscriptSegment {
  id: string
  start: Seconds
  end: Seconds
  text: string
  words: TranscriptWord[]
}

export interface Transcript {
  language: string
  durationSec: Seconds
  segments: TranscriptSegment[]
  /** 'whisper' for the real API, 'mock' when running keyless. */
  source: 'whisper' | 'mock'
}

// ---------------------------------------------------------------------------
// EDL entries
// ---------------------------------------------------------------------------

export type EditOrigin = 'pipeline' | 'ai-review' | 'ai-revision' | 'manual'

/** A region of the SOURCE to REMOVE. Cuts are data until stage 2 applies them. */
export interface CutRegion extends TimeRegion {
  id: string
  origin: EditOrigin
  status: 'proposed' | 'validated' | 'rejected'
  /** Keep-pad already applied to start/end (ms of lead/tail retained). */
  padMs: number
  /** Why the AI flagged/repaired this cut, if it did. */
  note?: string
}

export type TransitionKind = 'crossfade' | 'dip-to-black'

/**
 * Placed at a boundary. Like ALL EDL events, anchored in SOURCE time —
 * conversion to the trimmed timeline happens at render time (timemap.ts),
 * so cut revisions can never leave events pointing at stale positions.
 */
export interface TransitionEvent {
  id: string
  /** Seconds on the SOURCE timeline where the boundary sits. */
  at: Seconds
  kind: TransitionKind
  durationSec: Seconds
  origin: EditOrigin
}

export type GraphicTemplateId =
  | 'lower-third'
  | 'title-card'
  | 'stat-callout'
  | 'numbered-list'
  | 'quote-card'
  | 'section-card'

export interface GraphicEvent {
  id: string
  /** Seconds on the SOURCE timeline (converted to trimmed at render time). */
  at: Seconds
  durationSec: Seconds
  templateId: GraphicTemplateId
  /** Slot name → content. Slots are defined by the template. */
  slots: Record<string, string>
  status: 'planned' | 'approved' | 'rendered' | 'rejected'
  /** Alpha-MP4 path once HyperFrames has rendered it. */
  renderPath?: string
  origin: EditOrigin
  /** AI's one-line rationale, shown in the approval UI. */
  rationale?: string
}

export interface SfxEvent {
  id: string
  /** SOURCE-timeline seconds. */
  at: Seconds
  filePath: string
  gainDb: number
  origin: EditOrigin
}

export interface MusicCue {
  id: string
  /** SOURCE-timeline region this track underlays. */
  region: TimeRegion
  filePath: string
  gainDb: number
  /** Duck level applied under speech, in dB (negative). */
  duckDb: number
  fadeInSec: number
  fadeOutSec: number
  origin: EditOrigin
}

export interface CaptionStyle {
  enabled: boolean
  fontFamily: string
  /** Path to a user-loaded .ttf/.otf, if any — wins over fontFamily. */
  fontPath?: string
  fontSizePx: number
  primaryColor: string
  outlineColor: string
  position: 'bottom' | 'top' | 'center'
}

/** The whole edit as data. Every stage and every revision mutates this. */
export interface EDL {
  cuts: CutRegion[]
  transitions: TransitionEvent[]
  graphics: GraphicEvent[]
  sfx: SfxEvent[]
  music: MusicCue[]
  captions: CaptionStyle
  /** Monotonic revision counter — bumped on every mutation for staleness checks. */
  version: number
}

// ---------------------------------------------------------------------------
// Brand kit
// ---------------------------------------------------------------------------

export interface BrandKit {
  fontDisplay: string
  fontBody: string
  /** User-loaded font files (.ttf/.otf) registered for graphics + captions. */
  customFonts: { name: string; path: string }[]
  palette: {
    primary: string
    secondary: string
    accent: string
    background: string
    text: string
  }
  logoPath?: string
}

// ---------------------------------------------------------------------------
// Revisions & undo
// ---------------------------------------------------------------------------

export interface RevisionInstruction {
  id: string
  createdAt: string
  /** The user's natural-language ask. */
  text: string
  /** Region the user selected (timeline seconds, trimmed) — optional. */
  region?: TimeRegion
  /** Transcript segment ids the user selected — optional. */
  segmentIds?: string[]
  /** Stage the AI mapped this to. */
  mappedStage?: StageId
  /** Structured action the AI derived. */
  action?: RevisionAction
  status: 'pending' | 'applied' | 'failed' | 'rejected'
  error?: string
}

export type RevisionAction =
  | { kind: 'adjust-cut'; cutId?: string; region: TimeRegion; mode: 'tighten' | 'loosen' | 'remove-cut' | 'add-cut' }
  | { kind: 'remove-graphic'; graphicId: string }
  | { kind: 'add-graphic'; graphic: Omit<GraphicEvent, 'id' | 'status' | 'origin'> }
  | { kind: 'restyle-graphic'; graphicId: string; slots: Record<string, string> }
  | { kind: 'swap-transition'; transitionId: string; to: TransitionKind; durationSec?: Seconds }
  | { kind: 'music-gain'; cueId?: string; region: TimeRegion; deltaDb: number }
  | { kind: 'swap-music'; cueId: string; filePath?: string }

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface SourceInfo {
  path: string
  durationSec: Seconds
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

/**
 * An item in the project's media pool. Videos and folders are referenced IN
 * PLACE (never copied); folders keep their on-disk structure so the pool
 * mirrors the user's own sorting. One video is picked as the active `source`
 * the AI pipeline edits.
 */
export interface MediaItem {
  id: string
  name: string
  /** Absolute path on disk — referenced in place, never copied or moved. */
  path: string
  kind: 'video' | 'folder'
  /** Present only for folders. */
  children?: MediaItem[]
  /** Edit order (1-based) for videos included in the auto-edit. Undefined means
   *  the clip is excluded from the sequence. */
  order?: number
}

export interface Project {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** Original file — NEVER modified. All work happens in workDir. Undefined
   *  until the user attaches a source video to a freshly-named project. */
  source?: SourceInfo
  /** Imported media (videos + folders), referenced in place. The user picks one
   *  video from here as the active `source`. */
  media?: MediaItem[]
  workDir: string
  /**
   * Keep-segments snapshot from the last cut application — defines the
   * TRIMMED timeline the preview plays. The renderer maps playhead and
   * transcript times through this (see shared/timemap.ts).
   */
  trimKeep?: TimeRegion[]
  transcript?: Transcript
  edl: EDL
  stages: Record<StageId, StageState>
  revisions: RevisionInstruction[]
  brandKit: BrandKit
  approved: boolean
  previewPath?: string
  finalPath?: string
  shorts: ShortsProjectState[]
}

export interface ProjectSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  sourcePath: string
  durationSec: Seconds
  approved: boolean
}

// ---------------------------------------------------------------------------
// AI routing
// ---------------------------------------------------------------------------

export type AIProviderId = 'gemini' | 'openai' | 'deepseek' | 'anthropic' | 'mock'

export type AITask =
  | 'cut-review'
  | 'graphic-planning'
  | 'graphic-slot-filling'
  | 'revision-parsing'

export interface AIRoutingConfig {
  /** Per-task provider override; default is gemini for everything. */
  taskProviders: Record<AITask, AIProviderId>
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** False until the user has completed first-run setup (picked a folder). */
  onboarded: boolean
  /** Master folder where all projects + intermediate renders live. When unset,
   *  a default under the app's user-data directory is used. */
  projectsDir?: string
  /** Which keys exist — the values never cross the IPC boundary. */
  keysPresent: Record<'gemini' | 'openai' | 'deepseek' | 'anthropic' | 'opusclip', boolean>
  routing: AIRoutingConfig
  silence: { thresholdDb: number; minSilenceSec: number; keepPadMs: number }
  scene: { threshold: number; defaultTransition: TransitionKind; defaultDurationSec: number }
  musicLibraryDir?: string
  sfxLibraryDir?: string
  hosting: HostingSettings
  export: { preferNvenc: boolean }
  opusclip: { brandTemplateId?: string; webhookUrl?: string }
  brandKit: BrandKit
}

export interface HostingSettings {
  kind: 's3'
  bucket?: string
  region?: string
  endpoint?: string
  publicBaseUrl?: string
  /** Access/secret live in safeStorage alongside API keys. */
  configured: boolean
}

// ---------------------------------------------------------------------------
// Render queue
// ---------------------------------------------------------------------------

export type JobKind = 'probe' | 'stage-run' | 'final-export' | 'opusclip-submit'

export interface RenderJob {
  id: string
  kind: JobKind
  label: string
  projectId: string
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled'
  /** 0..1, or -1 when indeterminate. */
  progress: number
  detail?: string
  error?: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Shorts (OpusClip)
// ---------------------------------------------------------------------------

export interface ShortsProjectState {
  id: string
  opusProjectId?: string
  videoUrl?: string
  status: 'uploading' | 'submitted' | 'processing' | 'done' | 'error'
  error?: string
  clips: OpusClipResult[]
  createdAt: string
}

export interface OpusClipResult {
  id: string
  title?: string
  previewUrl?: string
  downloadUrl?: string
  durationSec?: number
  viralityScore?: number
}

// ---------------------------------------------------------------------------
// Export presets
// ---------------------------------------------------------------------------

export interface ExportPreset {
  id: string
  label: string
  width: number
  height: number
  fps?: number
  videoCodec: 'h264' | 'hevc'
  crf: number
  container: 'mp4'
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'yt-1080p', label: 'YouTube 1080p (landscape)', width: 1920, height: 1080, videoCodec: 'h264', crf: 18, container: 'mp4' },
  { id: 'vertical-1080', label: 'Vertical 1080×1920 (Shorts/Reels)', width: 1080, height: 1920, videoCodec: 'h264', crf: 18, container: 'mp4' }
]

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  status: 'up-to-date' | 'update-available' | 'downloaded' | 'error' | 'dev-mode'
  currentVersion: string
  latestVersion?: string
  message: string
}

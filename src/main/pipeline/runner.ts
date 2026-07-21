/**
 * Pipeline stage runner.
 *
 * Runs the six stages in STRICT ORDER (STAGE_ORDER in shared/types.ts):
 *   1. cut-detect   — silence → proposed cuts (data only)
 *   2. cut-review   — AI validates cuts, THEN cuts are applied → trimmed.mp4
 *   3. transitions  — scene detection on trimmed video → transition events → baked
 *   4. graphics     — AI plan → PAUSES for user approval → HyperFrames → composite
 *   5. audio        — SFX + music with auto-ducking → mixed.mp4
 *   6. preview      — 540p review artifact
 *
 * TIME DOMAINS: every EDL entry (cuts, transitions, graphics, music, sfx) is
 * stored in SOURCE time. Conversions to the trimmed timeline happen only at
 * FFmpeg-argument-build time, via the keep-segments of the current cut list
 * (shared/timemap.ts). This means a cut revision automatically re-anchors all
 * downstream events — nothing in the EDL ever goes stale when cuts move.
 *
 * Every stage records decisions in the EDL, so any stage can re-run in
 * isolation during revision. Downstream stages are marked 'stale' when an
 * upstream stage re-runs or when a manual EDL edit touches their inputs.
 */
import { BrowserWindow } from 'electron'
import { STAGE_ORDER, type CutRegion, type EDL, type Project, type StageId, type TimeRegion } from '@shared/types'
import { IPC } from '@shared/ipc'
import { newId } from '@shared/id'
import { cutsToKeepSegments, sourceToTrimmedTime, trimmedToSourceTime } from '@shared/timemap'
import { saveProject, setProjectSource, orderedClipPaths } from '../project'
import { buildSequence } from '../media/sequence'
import { enqueueAndWait, type JobContext } from '../queue'
import { detectSilence, silencesToCuts, transcriptGapCuts, refineCuts } from '../media/silence'
import { detectSceneChanges } from '../media/scenes'
import { applyCuts, applyTransitions, compositeGraphics, mixAudio, exportPreview, requireSource } from '../media/render'
import { buildAssFile } from '../media/captions'
import { transcribe, estimateCost } from '../transcription/whisper'
import { reviewCuts, planGraphics } from '../ai/tasks'
import { findRetakesDeterministic, findRetakesAI, mergeRemovals } from '../ai/retakes'
import { renderGraphic } from '../graphics/hyperframes'
import { getSettingsStore } from '../settings'

export function pushProject(project: Project): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.projectEvent, project)
  }
}

function save(project: Project): void {
  saveProject(project)
  pushProject(project)
}

function markStale(project: Project, from: StageId): void {
  const idx = STAGE_ORDER.indexOf(from)
  for (const id of STAGE_ORDER.slice(idx + 1)) {
    if (project.stages[id].status === 'done') project.stages[id].status = 'stale'
  }
}

/**
 * Mark stages stale based on which EDL sections a manual edit changed.
 * Called from the edl:update IPC handler so hand edits invalidate renders
 * exactly like pipeline re-runs do.
 */
export function markStaleForEdlChange(project: Project, before: EDL, after: EDL): void {
  const changed = (k: keyof EDL) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
  let from: StageId | null = null
  if (changed('cuts')) from = 'cut-detect'
  else if (changed('transitions')) from = 'cut-review'
  else if (changed('graphics')) from = 'transitions'
  else if (changed('sfx') || changed('music')) from = 'graphics'
  else if (changed('captions')) from = 'audio'
  if (from) markStale(project, from)
}

/** Keep-segments derived from current validated cuts. */
export function keepSegments(project: Project): TimeRegion[] {
  return cutsToKeepSegments(project.edl.cuts, project.source?.durationSec ?? 0)
}

/**
 * Keep-map for RENDER-TIME conversions. Artifacts downstream of stage 2 are
 * all derived from trimmed.mp4, so conversions against them must use the
 * snapshot captured when trimmed.mp4 was built (project.trimKeep) — NOT the
 * live cut list, which may have changed since (that mismatch would anchor
 * events through the wrong map). When cuts change, cut-review goes stale and
 * a re-run refreshes both trimmed.mp4 and this snapshot together.
 */
export function renderKeep(project: Project): TimeRegion[] {
  return project.trimKeep ?? keepSegments(project)
}

/**
 * Latest upstream artifact at or before `upTo`, derived from STAGE_ORDER so
 * inserting a stage can never silently skip it in one hand-written chain.
 */
export function latestArtifact(project: Project, upTo: StageId): string | undefined {
  const idx = STAGE_ORDER.indexOf(upTo)
  for (let i = idx; i >= 0; i--) {
    const p = project.stages[STAGE_ORDER[i]].artifactPath
    if (p) return p
  }
  return undefined
}

/** Speech regions on the trimmed timeline, for ducking. Adjacent segments are
 *  merged (gap < 1s): hundreds of per-segment terms would bloat the ducking
 *  volume expression, and music pumping between every sentence sounds bad
 *  anyway — duck through short pauses, come back up in real breaks. */
function speechRegionsTrimmed(project: Project, keep: TimeRegion[]): TimeRegion[] {
  if (!project.transcript) return []
  const mapped = project.transcript.segments
    .map((s) => ({
      start: sourceToTrimmedTime(s.start, keep),
      end: sourceToTrimmedTime(s.end, keep)
    }))
    .filter((r) => r.end - r.start > 0.2)
    .sort((a, b) => a.start - b.start)
  const merged: TimeRegion[] = []
  for (const r of mapped) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end < 1.0) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

// ---------------------------------------------------------------------------
// Stage implementations
// ---------------------------------------------------------------------------

async function stageCutDetect(project: Project, ctx: JobContext): Promise<void> {
  const source = requireSource(project)
  const cfg = getSettingsStore().getSettings().silence

  // Transcription happens up front (needed by stages 2, 4, 5, captions).
  if (!project.transcript) {
    ctx.progress(0.05, 'Transcribing audio…')
    project.transcript = await transcribe(
      source.path,
      project.workDir,
      source.durationSec,
      ctx.signal,
      (f) => ctx.progress(0.05 + f * 0.45, 'Transcribing audio…')
    )
    save(project)
  }

  // Prefer transcript-driven, pause-shaped gap cuts (keep words + a natural
  // beat, longer at sentence ends) — far more accurate than an audio-dB
  // threshold. Fall back to audio silencedetect only without a real transcript.
  const hasWords = project.transcript && project.transcript.source !== 'mock'
  ctx.progress(0.55, hasWords ? 'Finding gaps between words…' : 'Detecting silence…')
  const gapCuts: CutRegion[] = hasWords
    ? transcriptGapCuts(project.transcript!, source.durationSec, cfg)
    : silencesToCuts(await detectSilence(source.path, cfg, source.durationSec, ctx.signal), cfg)

  // Retake removal — two layers: a deterministic near-duplicate pass (always
  // catches "say it until it's right" repeats, keeps the LAST take) plus an AI
  // pass for paraphrased retakes, validated against the transcript before it
  // may cut anything. Best-effort: a model failure never fails the stage.
  let retakeCuts: CutRegion[] = []
  if (hasWords) {
    ctx.progress(0.7, 'Finding repeated takes…')
    const deterministic = findRetakesDeterministic(project.transcript!)
    let fromAI: typeof deterministic = []
    try {
      fromAI = await findRetakesAI(project.transcript!, ctx.signal)
    } catch (err) {
      console.warn('[retake-detection] AI pass skipped:', err)
    }
    retakeCuts = mergeRemovals(deterministic, fromAI).map((r) => ({
      id: newId('cut'),
      start: r.start,
      end: r.end,
      padMs: 0,
      origin: 'pipeline' as const,
      status: 'proposed' as const,
      kind: 'retake' as const,
      note: r.reason
    }))
  }

  // Merge overlaps and swallow sub-0.3s keep slivers between adjacent cuts —
  // half-word fragments between a retake cut and a gap cut play as stutter.
  const proposed = refineCuts([...gapCuts, ...retakeCuts])

  // Keep the user's manual cuts AND revision-driven cuts; replace only prior
  // pipeline-proposed cuts (silence + retakes) so a stage-1 re-run can't wipe
  // an 'add-cut' revision the user just made.
  const kept = project.edl.cuts.filter((c) => c.origin === 'manual' || c.origin === 'ai-revision')
  project.edl.cuts = [...kept, ...proposed]
  project.edl.version++
  ctx.progress(1, `${project.edl.cuts.length} cuts proposed${retakeCuts.length ? ` (${retakeCuts.length} retake cuts)` : ''}`)
}

async function stageCutReview(project: Project, ctx: JobContext): Promise<void> {
  if (!project.transcript) throw new Error('No transcript. Run stage 1 first.')
  ctx.progress(0.1, 'AI reviewing cut list…')
  // The reviewer judges cuts as SILENCE removals ("does this clip speech?").
  // Retake cuts intentionally remove speech — sending them through that lens
  // would get them rejected and resurrect the repeated takes. They were
  // already validated by the retake detector, so they pass through directly.
  const proposed = project.edl.cuts.filter((c) => c.status === 'proposed' && c.kind !== 'retake')
  if (proposed.length > 0) {
    const reviewed = await reviewCuts(proposed, project.transcript, ctx.signal)
    const reviewedIds = new Set(reviewed.map((c) => c.id))
    project.edl.cuts = [...project.edl.cuts.filter((c) => !reviewedIds.has(c.id)), ...reviewed]
  }
  // Manual cuts are trusted; retake cuts were validated by their own detector.
  project.edl.cuts = project.edl.cuts.map((c) =>
    c.status === 'proposed' && (c.origin === 'manual' || c.kind === 'retake') ? { ...c, status: 'validated' } : c
  )
  project.edl.version++
  save(project)

  ctx.progress(0.4, 'Applying validated cuts…')
  const { outPath, keep } = await applyCuts(project, {
    signal: ctx.signal,
    onProgress: (f) => ctx.progress(0.4 + f * 0.6, 'Applying validated cuts…')
  })
  project.stages['cut-review'].artifactPath = outPath
  // Snapshot the keep-segments that define the trimmed timeline the preview
  // will play — the renderer maps playhead/transcript times through this.
  project.trimKeep = keep
}

async function stageTransitions(project: Project, ctx: JobContext): Promise<void> {
  const trimmed = project.stages['cut-review'].artifactPath
  if (!trimmed) throw new Error('No trimmed video. Run stage 2 first.')
  const cfg = getSettingsStore().getSettings().scene
  // Must be the keep-map trimmed.mp4 was BUILT with — boundaries detected on
  // that file convert back to source through the same map.
  const keep = renderKeep(project)

  ctx.progress(0.1, 'Detecting scene changes…')
  // Scene detection runs on the trimmed video → boundaries arrive in trimmed
  // time; store them anchored in SOURCE time like everything else.
  const detected = await detectSceneChanges(trimmed, cfg.threshold, ctx.signal)

  // CRITICAL FILTER: after dead-space removal, every cut join is a jump cut,
  // and the scene detector fires on almost all of them — which used to bake a
  // dip-to-black every few seconds ("flashing"). A real scene change inside
  // continuous footage does NOT coincide with a join, so drop any detected
  // boundary within 0.5s of one. Clip handoffs in a multi-clip sequence ARE
  // real scene changes — they're added back explicitly below.
  const joinsTrimmed: number[] = []
  {
    let acc = 0
    for (let i = 0; i < keep.length - 1; i++) {
      acc += keep[i].end - keep[i].start
      joinsTrimmed.push(acc)
    }
  }
  const nearJoin = (t: number) => joinsTrimmed.some((j) => Math.abs(j - t) < 0.5)
  const realChanges = detected.filter((t) => !nearJoin(t))

  const clipChangesTrimmed = (project.clipBoundaries ?? [])
    .map((b) => sourceToTrimmedTime(b, keep))
    .filter((t) => t > 1)

  // Density cap: transitions are seasoning, not the meal. Enforce ≥10s spacing
  // (clip boundaries win over detected changes), skip the first/last 2 seconds.
  const trimmedLen = keep.reduce((a, k) => a + (k.end - k.start), 0)
  const candidates = [
    ...clipChangesTrimmed.map((at) => ({ at, priority: 0 })),
    ...realChanges.map((at) => ({ at, priority: 1 }))
  ]
    .filter((c) => c.at > 2 && c.at < trimmedLen - 2)
    .sort((a, b) => a.priority - b.priority || a.at - b.at)
  const placed: number[] = []
  for (const c of candidates) {
    if (placed.every((p) => Math.abs(p - c.at) >= 10)) placed.push(c.at)
  }
  placed.sort((a, b) => a - b)

  const manual = project.edl.transitions.filter((t) => t.origin !== 'pipeline')
  project.edl.transitions = [
    ...manual,
    ...placed.map((at) => ({
      id: newId('trn'),
      at: trimmedToSourceTime(at, keep),
      kind: cfg.defaultTransition,
      durationSec: cfg.defaultDurationSec,
      origin: 'pipeline' as const
    }))
  ]
  project.edl.version++
  save(project)

  ctx.progress(0.5, `Baking ${project.edl.transitions.length} transitions…`)
  const outPath = await applyTransitions(project, trimmed, keep, {
    signal: ctx.signal,
    onProgress: (f) => ctx.progress(0.5 + f * 0.5)
  })
  project.stages['transitions'].artifactPath = outPath
}

/**
 * Stage 4 phase A — PLAN only. Sets status 'awaiting-approval' and stops.
 * Rendering happens in approveGraphicsAndRender() after the user approves.
 * Graphics the user already approved/rendered are NEVER discarded by a
 * re-plan — only prior un-approved suggestions are replaced.
 */
async function stageGraphicsPlan(project: Project, ctx: JobContext): Promise<'paused'> {
  if (!project.transcript) throw new Error('No transcript. Run stage 1 first.')
  ctx.progress(0.2, 'AI planning graphics…')
  const planned = await planGraphics(project.transcript, ctx.signal)

  // Timestamps from the AI reference the transcript = SOURCE time. Keep them.
  const kept = project.edl.graphics.filter(
    (g) => g.origin !== 'pipeline' || g.status === 'approved' || g.status === 'rendered'
  )
  project.edl.graphics = [...kept, ...planned]
  project.edl.version++
  ctx.progress(1, `${planned.length} graphics planned — awaiting your approval`)
  return 'paused'
}

/** Render every approved-but-unrendered graphic, then composite. */
async function renderAndCompositeGraphics(project: Project, ctx: JobContext): Promise<void> {
  const toRender = project.edl.graphics.filter((g) => g.status === 'approved' && !g.renderPath)
  for (let i = 0; i < toRender.length; i++) {
    const g = toRender[i]
    ctx.progress(i / Math.max(1, toRender.length + 1), `HyperFrames: ${g.templateId}`)
    const result = await renderGraphic(project.workDir, g, project.brandKit, ctx.signal)
    g.renderPath = result.renderPath
    g.status = 'rendered'
    save(project)
  }

  ctx.progress(0.85, 'Compositing graphics…')
  const base = latestArtifact(project, 'transitions')
  if (!base) throw new Error('No upstream video to composite onto. Run earlier stages first.')
  const outPath = await compositeGraphics(project, base, renderKeep(project), { signal: ctx.signal })
  project.stages['graphics'].artifactPath = outPath
}

/** Stage 4 phase B — apply approval edits, render + composite, continue. */
export async function approveGraphicsAndRender(
  project: Project,
  approvedIds: string[],
  edits: Project['edl']['graphics']
): Promise<void> {
  // Apply user edits to the plan, mark approval status.
  const editById = new Map(edits.map((g) => [g.id, g]))
  project.edl.graphics = project.edl.graphics
    .map((g) => editById.get(g.id) ?? g)
    .map((g) => ({
      ...g,
      status: approvedIds.includes(g.id)
        ? g.renderPath
          ? g.status // already rendered — leave it
          : ('approved' as const)
        : g.status === 'planned'
          ? ('rejected' as const)
          : g.status
    }))
  project.edl.version++
  // Leave the approval gate immediately so the modal closes and the stage
  // rail shows progress; errors land in stages.graphics.error like any stage.
  project.stages['graphics'].status = 'running'
  save(project)

  try {
    await enqueueAndWait('stage-run', 'Stage 4: render + composite graphics', project.id, (ctx) =>
      renderAndCompositeGraphics(project, ctx)
    )
    project.stages['graphics'].status = 'done'
    project.stages['graphics'].finishedAt = new Date().toISOString()
    markStale(project, 'graphics')
    save(project)
  } catch (err: any) {
    project.stages['graphics'].status = 'error'
    project.stages['graphics'].error = err?.message ?? String(err)
    save(project)
    throw err
  }

  // Continue the pipeline automatically through audio + preview.
  await runStages(project, ['audio', 'preview'])
}

async function stageAudio(project: Project, ctx: JobContext): Promise<void> {
  const base = latestArtifact(project, 'graphics')
  if (!base) throw new Error('No upstream video. Run earlier stages first.')
  const keep = renderKeep(project)

  ctx.progress(0.2, 'Mixing music + SFX with auto-ducking…')
  const outPath = await mixAudio(project, base, keep, speechRegionsTrimmed(project, keep), {
    signal: ctx.signal,
    onProgress: (f) => ctx.progress(0.2 + f * 0.8)
  })
  project.stages['audio'].artifactPath = outPath
}

async function stagePreview(project: Project, ctx: JobContext): Promise<void> {
  const base = latestArtifact(project, 'audio')
  if (!base) throw new Error('No upstream video. Run earlier stages first.')

  ctx.progress(0.1, 'Rendering 540p preview…')
  // Preview keeps the source aspect ratio (scale=-2:540); match the ASS canvas.
  const previewH = 540
  const src = requireSource(project)
  const previewW = Math.max(2, Math.round((previewH * src.width) / Math.max(1, src.height)))
  const ass = project.transcript
    ? buildAssFile(project.workDir, project.transcript, project.edl.captions, project.brandKit, renderKeep(project), {
        width: previewW,
        height: previewH
      })
    : null
  const outPath = await exportPreview(project, base, ass, {
    signal: ctx.signal,
    onProgress: (f) => ctx.progress(0.1 + f * 0.9, 'Rendering 540p preview…')
  })
  project.stages['preview'].artifactPath = outPath
  project.previewPath = outPath
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

type StageFn = (project: Project, ctx: JobContext) => Promise<void | 'paused'>

const STAGE_FNS: Record<StageId, StageFn> = {
  'cut-detect': stageCutDetect,
  'cut-review': stageCutReview,
  transitions: stageTransitions,
  graphics: stageGraphicsPlan,
  audio: stageAudio,
  preview: stagePreview
}

const STAGE_LABELS: Record<StageId, string> = {
  'cut-detect': 'Stage 1: detect dead space',
  'cut-review': 'Stage 2: AI cut review + apply',
  transitions: 'Stage 3: scene transitions',
  graphics: 'Stage 4: plan graphics',
  audio: 'Stage 5: music + SFX mix',
  preview: 'Stage 6: preview export'
}

export async function runStages(project: Project, stages: StageId[]): Promise<void> {
  for (const id of stages) {
    const state = project.stages[id]
    state.status = 'running'
    state.error = undefined
    state.startedAt = new Date().toISOString()
    save(project)
    try {
      let paused = false
      await enqueueAndWait('stage-run', STAGE_LABELS[id], project.id, async (ctx) => {
        const result = await STAGE_FNS[id](project, ctx)
        paused = result === 'paused'
      })
      state.status = paused ? 'awaiting-approval' : 'done'
      if (!paused) {
        state.finishedAt = new Date().toISOString()
        markStale(project, id)
      }
      save(project)
      if (paused) return // graphics approval gate — stop the run here
    } catch (err: any) {
      state.status = 'error'
      state.error = err?.message ?? String(err)
      save(project)
      throw err
    }
  }
}

/** Full pipeline run in strict order (stops at the graphics approval gate). */
export async function runFullPipeline(project: Project): Promise<void> {
  await runStages(project, [...STAGE_ORDER])
}

/**
 * Multi-clip auto-edit: concatenate the numbered clips (in order) into one
 * working video, set it as the source, then run the full pipeline. A single
 * numbered clip is edited in place with no concat.
 */
export async function startAutoEdit(project: Project): Promise<void> {
  const clips = orderedClipPaths(project)
  if (clips.length === 0) {
    throw new Error('Number at least one clip to include it in the edit.')
  }

  let seqPath = ''
  let boundaries: number[] = []
  await enqueueAndWait(
    'stage-run',
    clips.length > 1 ? `Building sequence from ${clips.length} clips` : 'Preparing clip',
    project.id,
    async (ctx) => {
      const result = await buildSequence(project.workDir, clips, {
        signal: ctx.signal,
        onProgress: (f) => ctx.progress(f, 'Building sequence…')
      })
      seqPath = result.outPath
      boundaries = result.boundaries
    }
  )

  // force: the multi-clip sequence lives at a fixed path, so a re-run rebuilds
  // the same filename with new content — bypass the same-path no-op guard.
  const updated = await setProjectSource(project.id, seqPath, { force: true })
  // Clip handoffs are REAL scene changes — stage 3 places transitions there
  // and uses them to separate true changes from dead-space jump cuts.
  updated.clipBoundaries = boundaries
  saveProject(updated)
  pushProject(updated)
  await runFullPipeline(updated)
}

/**
 * Targeted re-run for revisions and manual edits: re-run `stage` and every
 * later stage, derived from STAGE_ORDER. The graphics stage is NOT re-planned
 * here — existing approved/rendered graphics are re-rendered (if their render
 * was invalidated) and re-composited at their source-anchored timestamps.
 * A full re-plan (with the approval gate) only happens on an explicit
 * "re-run stage 4" from the stage rail or a fresh pipeline run.
 */
export async function runSingleStage(project: Project, stage: StageId, _region?: TimeRegion): Promise<void> {
  if (stage === 'cut-detect') {
    // Proposals only — the user reviews them before anything re-applies.
    await runStages(project, ['cut-detect'])
    return
  }

  const downstream = STAGE_ORDER.slice(STAGE_ORDER.indexOf(stage))
  for (const id of downstream) {
    if (id === 'graphics') {
      const hasGraphics = project.edl.graphics.some((g) => g.status === 'approved' || g.status === 'rendered')
      if (!hasGraphics) {
        // Nothing left to composite (e.g. the last graphic was just removed):
        // DROP the old composite artifact so audio/preview fall back to the
        // transitions output — otherwise the removed graphic would live on,
        // baked into the stale graphics.mp4.
        if (project.stages['graphics'].artifactPath) {
          project.stages['graphics'].artifactPath = undefined
          if (project.stages['graphics'].status !== 'pending') project.stages['graphics'].status = 'done'
          save(project)
        }
        continue
      }
      const state = project.stages['graphics']
      state.status = 'running'
      state.error = undefined
      save(project)
      try {
        await enqueueAndWait('stage-run', 'Re-composite graphics', project.id, (ctx) =>
          renderAndCompositeGraphics(project, ctx)
        )
        state.status = 'done'
        state.finishedAt = new Date().toISOString()
        save(project)
      } catch (err: any) {
        state.status = 'error'
        state.error = err?.message ?? String(err)
        save(project)
        throw err
      }
    } else {
      await runStages(project, [id])
    }
  }
}

/** Explicit re-plan of stage 4 (stage-rail button / fresh runs) — gated. */
export async function replanGraphics(project: Project): Promise<void> {
  await runStages(project, ['graphics'])
}

export function transcriptEstimate(project: Project): { minutes: number; estUsd: number } {
  return estimateCost(project.source?.durationSec ?? 0)
}

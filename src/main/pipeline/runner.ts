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
 * Every stage records decisions in the EDL, so any stage can re-run in
 * isolation during revision. Downstream stages are marked 'stale' when an
 * upstream stage re-runs.
 */
import { BrowserWindow } from 'electron'
import { STAGE_ORDER, type Project, type StageId, type TimeRegion } from '@shared/types'
import { IPC } from '@shared/ipc'
import { newId } from '@shared/id'
import { saveProject } from '../project'
import { enqueueAndWait, type JobContext } from '../queue'
import { detectSilence, silencesToCuts, cutsToKeepSegments, sourceToTrimmedTime } from '../media/silence'
import { detectSceneChanges } from '../media/scenes'
import { applyCuts, applyTransitions, compositeGraphics, mixAudio, exportPreview } from '../media/render'
import { buildAssFile } from '../media/captions'
import { transcribe, estimateCost } from '../transcription/whisper'
import { reviewCuts, planGraphics } from '../ai/tasks'
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

/** Keep-segments derived from current validated cuts. */
export function keepSegments(project: Project): TimeRegion[] {
  return cutsToKeepSegments(project.edl.cuts, project.source.durationSec)
}

/** Speech regions on the trimmed timeline, for ducking. */
function speechRegionsTrimmed(project: Project): TimeRegion[] {
  if (!project.transcript) return []
  const keep = keepSegments(project)
  return project.transcript.segments
    .map((s) => ({
      start: sourceToTrimmedTime(s.start, keep),
      end: sourceToTrimmedTime(s.end, keep)
    }))
    .filter((r) => r.end - r.start > 0.2)
}

// ---------------------------------------------------------------------------
// Stage implementations
// ---------------------------------------------------------------------------

async function stageCutDetect(project: Project, ctx: JobContext): Promise<void> {
  const cfg = getSettingsStore().getSettings().silence

  // Transcription happens up front (needed by stages 2, 4, 5, captions).
  if (!project.transcript) {
    ctx.progress(0.05, 'Transcribing audio…')
    project.transcript = await transcribe(
      project.source.path,
      project.workDir,
      project.source.durationSec,
      ctx.signal,
      (f) => ctx.progress(0.05 + f * 0.45, 'Transcribing audio…')
    )
    save(project)
  }

  ctx.progress(0.55, 'Detecting silence…')
  const silences = await detectSilence(project.source.path, cfg, ctx.signal)
  // Keep manual cuts; replace prior pipeline-proposed ones.
  const manual = project.edl.cuts.filter((c) => c.origin === 'manual')
  project.edl.cuts = [...manual, ...silencesToCuts(silences, cfg)]
  project.edl.version++
  ctx.progress(1, `${project.edl.cuts.length} cuts proposed`)
}

async function stageCutReview(project: Project, ctx: JobContext): Promise<void> {
  if (!project.transcript) throw new Error('No transcript. Run stage 1 first.')
  ctx.progress(0.1, 'AI reviewing cut list…')
  const proposed = project.edl.cuts.filter((c) => c.status === 'proposed')
  if (proposed.length > 0) {
    const reviewed = await reviewCuts(proposed, project.transcript, ctx.signal)
    const reviewedIds = new Set(reviewed.map((c) => c.id))
    project.edl.cuts = [...project.edl.cuts.filter((c) => !reviewedIds.has(c.id)), ...reviewed]
  }
  // Manual cuts are trusted as validated.
  project.edl.cuts = project.edl.cuts.map((c) =>
    c.origin === 'manual' && c.status === 'proposed' ? { ...c, status: 'validated' } : c
  )
  project.edl.version++
  save(project)

  ctx.progress(0.4, 'Applying validated cuts…')
  const { outPath } = await applyCuts(project, {
    signal: ctx.signal,
    onProgress: (f) => ctx.progress(0.4 + f * 0.6, 'Applying validated cuts…')
  })
  project.stages['cut-review'].artifactPath = outPath
}

async function stageTransitions(project: Project, ctx: JobContext): Promise<void> {
  const trimmed = project.stages['cut-review'].artifactPath
  if (!trimmed) throw new Error('No trimmed video. Run stage 2 first.')
  const cfg = getSettingsStore().getSettings().scene

  ctx.progress(0.1, 'Detecting scene changes…')
  const boundaries = await detectSceneChanges(trimmed, cfg.threshold, ctx.signal)

  const manual = project.edl.transitions.filter((t) => t.origin !== 'pipeline')
  project.edl.transitions = [
    ...manual,
    ...boundaries.map((at) => ({
      id: newId('trn'),
      at,
      kind: cfg.defaultTransition,
      durationSec: cfg.defaultDurationSec,
      origin: 'pipeline' as const
    }))
  ]
  project.edl.version++
  save(project)

  ctx.progress(0.5, `Baking ${project.edl.transitions.length} transitions…`)
  const outPath = await applyTransitions(project, trimmed, {
    signal: ctx.signal,
    onProgress: (f) => ctx.progress(0.5 + f * 0.5)
  })
  project.stages['transitions'].artifactPath = outPath
}

/**
 * Stage 4 phase A — PLAN only. Sets status 'awaiting-approval' and stops.
 * Rendering happens in approveGraphicsAndRender() after the user approves.
 */
async function stageGraphicsPlan(project: Project, ctx: JobContext): Promise<'paused'> {
  if (!project.transcript) throw new Error('No transcript. Run stage 1 first.')
  ctx.progress(0.2, 'AI planning graphics…')
  const planned = await planGraphics(project.transcript, ctx.signal)

  // Remap plan timestamps (source timeline) onto the trimmed timeline.
  const keep = keepSegments(project)
  const kept = project.edl.graphics.filter((g) => g.origin === 'manual' || g.origin === 'ai-revision')
  project.edl.graphics = [
    ...kept,
    ...planned.map((g) => ({ ...g, at: sourceToTrimmedTime(g.at, keep) }))
  ]
  project.edl.version++
  ctx.progress(1, `${planned.length} graphics planned — awaiting your approval`)
  return 'paused'
}

/** Stage 4 phase B — render approved graphics with HyperFrames + composite. */
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
      status: approvedIds.includes(g.id) ? ('approved' as const) : g.status === 'planned' ? ('rejected' as const) : g.status
    }))
  project.edl.version++
  save(project)

  await enqueueAndWait('stage-run', 'Stage 4: render + composite graphics', project.id, async (ctx) => {
    const approved = project.edl.graphics.filter((g) => g.status === 'approved')
    for (let i = 0; i < approved.length; i++) {
      const g = approved[i]
      ctx.progress(i / Math.max(1, approved.length + 1), `HyperFrames: ${g.templateId} @ ${g.at.toFixed(1)}s`)
      const result = await renderGraphic(project.workDir, g, project.brandKit, ctx.signal)
      g.renderPath = result.renderPath
      g.status = 'rendered'
      save(project)
    }

    ctx.progress(0.85, 'Compositing graphics…')
    const base = project.stages['transitions'].artifactPath ?? project.stages['cut-review'].artifactPath
    if (!base) throw new Error('No upstream video to composite onto.')
    const outPath = await compositeGraphics(project, base, { signal: ctx.signal })
    project.stages['graphics'].artifactPath = outPath
    project.stages['graphics'].status = 'done'
    project.stages['graphics'].finishedAt = new Date().toISOString()
    markStale(project, 'graphics')
    save(project)
  })

  // Continue the pipeline automatically through audio + preview.
  await runStages(project, ['audio', 'preview'])
}

async function stageAudio(project: Project, ctx: JobContext): Promise<void> {
  const base =
    project.stages['graphics'].artifactPath ??
    project.stages['transitions'].artifactPath ??
    project.stages['cut-review'].artifactPath
  if (!base) throw new Error('No upstream video. Run earlier stages first.')

  ctx.progress(0.2, 'Mixing music + SFX with auto-ducking…')
  const outPath = await mixAudio(project, base, speechRegionsTrimmed(project), {
    signal: ctx.signal,
    onProgress: (f) => ctx.progress(0.2 + f * 0.8)
  })
  project.stages['audio'].artifactPath = outPath
}

async function stagePreview(project: Project, ctx: JobContext): Promise<void> {
  const base =
    project.stages['audio'].artifactPath ??
    project.stages['graphics'].artifactPath ??
    project.stages['transitions'].artifactPath ??
    project.stages['cut-review'].artifactPath
  if (!base) throw new Error('No upstream video. Run earlier stages first.')

  ctx.progress(0.1, 'Rendering 540p preview…')
  const ass = project.transcript
    ? buildAssFile(project.workDir, project.transcript, project.edl.captions, project.brandKit, keepSegments(project))
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
      state.finishedAt = new Date().toISOString()
      if (!paused) markStale(project, id)
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

/** Re-run one stage in isolation (targeted revision), then refresh preview. */
export async function runSingleStage(project: Project, stage: StageId, _region?: TimeRegion): Promise<void> {
  // Region-targeting note: stages read the EDL, which already carries the
  // region-scoped changes a revision made. Re-running the stage + downstream
  // composite/preview is what makes the change visible. _region is accepted
  // for future segment-window optimization of the FFmpeg calls.
  const downstream: StageId[] = (() => {
    switch (stage) {
      case 'cut-detect':
        return ['cut-detect']
      case 'cut-review':
        return ['cut-review', 'transitions', 'audio', 'preview'] // graphics composite reuses renders
      case 'transitions':
        return ['transitions', 'audio', 'preview']
      case 'graphics':
        return ['graphics']
      case 'audio':
        return ['audio', 'preview']
      case 'preview':
        return ['preview']
    }
  })()

  // If graphics were already rendered, re-composite instead of re-planning.
  if (stage !== 'graphics' && downstream.includes('transitions') && project.stages.graphics.status === 'done') {
    await runStages(project, ['cut-review', 'transitions'].filter((s) => downstream.includes(s as StageId)) as StageId[])
    await enqueueAndWait('stage-run', 'Re-composite graphics', project.id, async (ctx) => {
      const base = project.stages['transitions'].artifactPath!
      project.stages['graphics'].artifactPath = await compositeGraphics(project, base, { signal: ctx.signal })
      save(project)
    })
    await runStages(project, ['audio', 'preview'])
    return
  }

  await runStages(project, downstream)
}

export function transcriptEstimate(project: Project): { minutes: number; estUsd: number } {
  return estimateCost(project.source.durationSec)
}

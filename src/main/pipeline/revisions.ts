/**
 * Review-loop revision handling: parse a natural-language instruction with
 * the AI router, apply the structured action to the EDL, then re-run ONLY the
 * affected stage (targeted re-render via runSingleStage).
 */
import { newId } from '@shared/id'
import type { Project, RevisionAction, RevisionInstruction, TimeRegion } from '@shared/types'
import { parseRevision, fillSlots } from '../ai/tasks'
import { saveProject } from '../project'
import { runSingleStage, pushProject } from './runner'
import { getSettingsStore } from '../settings'

// NOTE ON TIME DOMAINS: selection regions from the timeline/transcript, every
// EDL event, and the transcript itself are ALL in SOURCE time (see
// shared/timemap.ts), so every comparison in this file is domain-consistent.

export async function submitRevision(
  project: Project,
  text: string,
  region?: TimeRegion,
  segmentIds?: string[]
): Promise<RevisionInstruction> {
  const revision: RevisionInstruction = {
    id: newId('rev'),
    createdAt: new Date().toISOString(),
    text,
    region,
    segmentIds,
    status: 'pending'
  }
  project.revisions.push(revision)
  saveProject(project)
  pushProject(project)

  try {
    const selectedText = segmentIds?.length
      ? project.transcript?.segments
          .filter((s) => segmentIds.includes(s.id))
          .map((s) => s.text)
          .join(' ')
      : undefined

    const parsed = await parseRevision(text, {
      region,
      selectedText,
      graphics: project.edl.graphics.map((g) => ({ id: g.id, templateId: g.templateId, at: g.at })),
      transitions: project.edl.transitions.map((t) => ({ id: t.id, at: t.at, kind: t.kind })),
      musicCues: project.edl.music.map((m) => ({ id: m.id, region: m.region }))
    })

    revision.mappedStage = parsed.stage
    revision.action = parsed.action
    await applyAction(project, parsed.action)
    project.edl.version++
    saveProject(project)

    await runSingleStage(project, parsed.stage, region)
    revision.status = 'applied'
  } catch (err: any) {
    revision.status = 'failed'
    revision.error = err?.message ?? String(err)
  }
  saveProject(project)
  pushProject(project)
  return revision
}

async function applyAction(project: Project, action: RevisionAction): Promise<void> {
  const edl = project.edl
  switch (action.kind) {
    case 'adjust-cut': {
      const { region, mode } = action
      if (mode === 'add-cut') {
        edl.cuts.push({ id: newId('cut'), ...region, padMs: 0, origin: 'ai-revision', status: 'validated' })
      } else if (mode === 'remove-cut') {
        edl.cuts = edl.cuts.map((c) =>
          overlaps(c, region) ? { ...c, status: 'rejected' as const, origin: 'ai-revision' as const } : c
        )
      } else {
        // Symmetric fixed step derived from the configured keep-pad, so
        // tighten and loosen are exact inverses (no drift on repeated nudges).
        const stepSec = Math.max(0.08, getSettingsStore().getSettings().silence.keepPadMs / 1000)
        const delta = mode === 'tighten' ? stepSec : -stepSec // tighten = cut MORE
        edl.cuts = edl.cuts.map((c) => {
          if (!overlaps(c, region) || c.status === 'rejected') return c
          const start = Math.max(0, c.start - delta)
          const end = c.end + delta
          if (end - start < 0.08) return c // would collapse — leave as-is
          return { ...c, start, end, origin: 'ai-revision' as const, note: `${mode} (${delta > 0 ? '+' : ''}${(delta * 1000).toFixed(0)}ms each side)` }
        })
      }
      break
    }
    case 'remove-graphic':
      edl.graphics = edl.graphics.map((g) => (g.id === action.graphicId ? { ...g, status: 'rejected' as const } : g))
      break
    case 'add-graphic': {
      const slots =
        Object.keys(action.graphic.slots ?? {}).length > 0
          ? action.graphic.slots
          : await fillSlots(action.graphic.templateId, transcriptContextAround(project, action.graphic.at))
      edl.graphics.push({
        ...action.graphic,
        slots,
        id: newId('gfx'),
        status: 'approved', // user asked for it explicitly — skip re-approval
        origin: 'ai-revision'
      })
      break
    }
    case 'restyle-graphic':
      edl.graphics = edl.graphics.map((g) =>
        g.id === action.graphicId
          ? { ...g, slots: { ...g.slots, ...action.slots }, status: 'approved' as const, renderPath: undefined }
          : g
      )
      break
    case 'swap-transition':
      edl.transitions = edl.transitions.map((t) =>
        t.id === action.transitionId
          ? { ...t, kind: action.to, durationSec: action.durationSec ?? t.durationSec, origin: 'ai-revision' as const }
          : t
      )
      break
    case 'music-gain':
      edl.music = edl.music.map((m) =>
        action.cueId ? (m.id === action.cueId ? { ...m, gainDb: m.gainDb + action.deltaDb } : m)
        : overlaps(m.region, action.region) ? { ...m, gainDb: m.gainDb + action.deltaDb } : m
      )
      break
    case 'swap-music': {
      const dir = getSettingsStore().getSettings().musicLibraryDir
      edl.music = edl.music.map((m) =>
        m.id === action.cueId
          ? { ...m, filePath: action.filePath ?? pickDifferentTrack(dir, m.filePath) ?? m.filePath, origin: 'ai-revision' as const }
          : m
      )
      break
    }
  }
}

function overlaps(a: TimeRegion, b: TimeRegion): boolean {
  return a.start < b.end && b.start < a.end
}

function transcriptContextAround(project: Project, at: number): string {
  const segs = project.transcript?.segments.filter((s) => Math.abs(s.start - at) < 20) ?? []
  return segs.map((s) => s.text).join(' ') || 'No transcript context available.'
}

function pickDifferentTrack(dir: string | undefined, current: string): string | null {
  if (!dir) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    const files = fs
      .readdirSync(dir)
      .filter((f: string) => /\.(mp3|wav|m4a|flac|ogg)$/i.test(f))
      .map((f: string) => require('path').join(dir, f))
      .filter((p: string) => p !== current)
    return files[Math.floor(Math.random() * files.length)] ?? null
  } catch {
    return null
  }
}

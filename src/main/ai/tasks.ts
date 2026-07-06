/**
 * The four routed AI tasks: cut review (stage 2), graphic planning + slot
 * filling (stage 4), and revision-instruction parsing (review loop).
 * Each builds a strict-JSON prompt, calls the router, and safely parses.
 */
import { runTask } from './router'
import { extractJson, isObject } from './json'
import { newId } from '@shared/id'
import type {
  CutRegion,
  GraphicEvent,
  GraphicTemplateId,
  RevisionAction,
  StageId,
  TimeRegion,
  Transcript
} from '@shared/types'
import { TEMPLATE_LIBRARY } from '../graphics/templates'

// ---------------------------------------------------------------------------
// Stage 2 — cut review
// ---------------------------------------------------------------------------

interface CutDecision {
  cutId: string
  verdict: 'keep' | 'reject' | 'adjust'
  newStart?: number
  newEnd?: number
  reason?: string
}

export async function reviewCuts(
  cuts: CutRegion[],
  transcript: Transcript,
  signal?: AbortSignal
): Promise<CutRegion[]> {
  const transcriptCompact = transcript.segments
    .map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`)
    .join('\n')
  const cutsCompact = cuts.map((c) => ({ id: c.id, start: c.start, end: c.end }))

  const raw = await runTask(
    'cut-review',
    {
      system:
        'TASK:cut-review — You are a video-edit QA reviewer. You receive a timed transcript and a list of ' +
        'proposed silence cuts (regions to REMOVE). Flag cuts that would: slice mid-word, remove a meaningful ' +
        'pause/beat (dramatic pause, comedic beat), or over-trim so speech feels clipped. ' +
        'Respond with STRICT JSON: {"decisions":[{"cutId":string,"verdict":"keep"|"reject"|"adjust",' +
        '"newStart"?:number,"newEnd"?:number,"reason"?:string}],"notes":string}. ' +
        'Only include decisions for cuts that need rejecting or adjusting; omitted cuts are kept as-is.',
      user: `TRANSCRIPT:\n${transcriptCompact}\n\nPROPOSED CUTS (seconds):\n${JSON.stringify(cutsCompact)}`,
      jsonSchemaHint: 'decisions array',
      temperature: 0.1
    },
    signal
  )

  const parsed = extractJson(raw, (v): v is { decisions: CutDecision[] } => isObject(v) && Array.isArray((v as any).decisions))

  const byId = new Map(parsed.decisions.map((d) => [d.cutId, d]))
  return cuts.map((c) => {
    const d = byId.get(c.id)
    if (!d || d.verdict === 'keep') return { ...c, status: 'validated' as const }
    if (d.verdict === 'reject') return { ...c, status: 'rejected' as const, note: d.reason, origin: 'ai-review' as const }
    return {
      ...c,
      start: typeof d.newStart === 'number' ? d.newStart : c.start,
      end: typeof d.newEnd === 'number' ? d.newEnd : c.end,
      status: 'validated' as const,
      note: d.reason,
      origin: 'ai-review' as const
    }
  })
}

// ---------------------------------------------------------------------------
// Stage 4 — graphic planning (approve-then-render; this only PLANS)
// ---------------------------------------------------------------------------

export async function planGraphics(transcript: Transcript, signal?: AbortSignal): Promise<GraphicEvent[]> {
  const templateDocs = Object.values(TEMPLATE_LIBRARY)
    .map((t) => `- ${t.id}: ${t.description}. Slots: ${t.slots.map((s) => `${s.name} (${s.description})`).join(', ')}`)
    .join('\n')
  const transcriptCompact = transcript.segments
    .map((s) => `[${s.start.toFixed(1)}] ${s.text}`)
    .join('\n')

  const raw = await runTask(
    'graphic-planning',
    {
      system:
        'TASK:graphic-planning — You plan on-screen graphics for an edited video. Choose ONLY from the fixed ' +
        `template library below; never invent templates or write HTML.\n${templateDocs}\n` +
        'Plan sparingly — a graphic must earn its place (a name introduction, a key stat, a list of tips, a strong quote, ' +
        'a section change). Respond with STRICT JSON: {"graphics":[{"at":number,"durationSec":number,' +
        '"templateId":string,"slots":{...},"rationale":string}]}. Timestamps are seconds on the video timeline.',
      user: `TIMED TRANSCRIPT:\n${transcriptCompact}`,
      jsonSchemaHint: 'graphics array',
      temperature: 0.4
    },
    signal
  )

  const parsed = extractJson(raw, (v): v is { graphics: any[] } => isObject(v) && Array.isArray((v as any).graphics))
  const validTemplates = new Set(Object.keys(TEMPLATE_LIBRARY))

  return parsed.graphics
    .filter((g) => validTemplates.has(g.templateId) && typeof g.at === 'number')
    .map((g) => ({
      id: newId('gfx'),
      at: Math.max(0, g.at),
      durationSec: typeof g.durationSec === 'number' ? Math.min(Math.max(g.durationSec, 1.5), 15) : 5,
      templateId: g.templateId as GraphicTemplateId,
      slots: isObject(g.slots) ? Object.fromEntries(Object.entries(g.slots).map(([k, v]) => [k, String(v)])) : {},
      status: 'planned' as const,
      origin: 'pipeline' as const,
      rationale: typeof g.rationale === 'string' ? g.rationale : undefined
    }))
}

// ---------------------------------------------------------------------------
// Stage 4 — slot filling (used when a revision adds a graphic with sparse info)
// ---------------------------------------------------------------------------

export async function fillSlots(
  templateId: GraphicTemplateId,
  context: string,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const template = TEMPLATE_LIBRARY[templateId]
  const raw = await runTask(
    'graphic-slot-filling',
    {
      system:
        `TASK:graphic-slot-filling — Fill the content slots for the "${template.id}" template ` +
        `(${template.description}). Slots: ${template.slots.map((s) => `${s.name}: ${s.description}`).join('; ')}. ` +
        'Respond with STRICT JSON: {"slots":{...}} using exactly those slot names. Keep copy short and punchy.',
      user: `CONTEXT:\n${context}`,
      jsonSchemaHint: 'slots object',
      temperature: 0.4
    },
    signal
  )
  const parsed = extractJson(raw, (v): v is { slots: Record<string, string> } => isObject(v) && isObject((v as any).slots))
  return Object.fromEntries(Object.entries(parsed.slots).map(([k, v]) => [k, String(v)]))
}

// ---------------------------------------------------------------------------
// Review loop — revision-instruction parsing
// ---------------------------------------------------------------------------

export interface ParsedRevision {
  stage: StageId
  action: RevisionAction
  explanation: string
}

export async function parseRevision(
  text: string,
  context: {
    region?: TimeRegion
    selectedText?: string
    graphics: { id: string; templateId: string; at: number }[]
    transitions: { id: string; at: number; kind: string }[]
    musicCues: { id: string; region: TimeRegion }[]
  },
  signal?: AbortSignal
): Promise<ParsedRevision> {
  const raw = await runTask(
    'revision-parsing',
    {
      system:
        'TASK:revision-parsing — Map a natural-language revision instruction from a video editor to ONE pipeline ' +
        'stage and ONE structured action. Stages: "cut-review" (cut adjustments), "transitions", "graphics", "audio". ' +
        'Actions (STRICT JSON, discriminated on "kind"): ' +
        '{"kind":"adjust-cut","region":{"start":n,"end":n},"mode":"tighten"|"loosen"|"remove-cut"|"add-cut"} | ' +
        '{"kind":"remove-graphic","graphicId":s} | ' +
        '{"kind":"add-graphic","graphic":{"at":n,"durationSec":n,"templateId":s,"slots":{},"rationale":s}} | ' +
        '{"kind":"restyle-graphic","graphicId":s,"slots":{}} | ' +
        '{"kind":"swap-transition","transitionId":s,"to":"crossfade"|"dip-to-black","durationSec"?:n} | ' +
        '{"kind":"music-gain","region":{"start":n,"end":n},"deltaDb":n} | ' +
        '{"kind":"swap-music","cueId":s}. ' +
        'Respond: {"stage":s,"action":{...},"explanation":s}.',
      user:
        `INSTRUCTION: ${text}\n` +
        (context.region ? `SELECTED REGION (s): ${JSON.stringify(context.region)}\n` : '') +
        (context.selectedText ? `SELECTED TRANSCRIPT: ${context.selectedText}\n` : '') +
        `GRAPHICS ON TIMELINE: ${JSON.stringify(context.graphics)}\n` +
        `TRANSITIONS: ${JSON.stringify(context.transitions)}\n` +
        `MUSIC CUES: ${JSON.stringify(context.musicCues)}`,
      jsonSchemaHint: 'revision mapping',
      temperature: 0.1
    },
    signal
  )

  return extractJson(
    raw,
    (v): v is ParsedRevision =>
      isObject(v) && typeof (v as any).stage === 'string' && isObject((v as any).action) && typeof (v as any).action.kind === 'string'
  )
}

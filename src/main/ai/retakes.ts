/**
 * Retake / false-start removal — two layers:
 *
 *  1. DETERMINISTIC: near-duplicate segment detection via token similarity.
 *     Catches the classic "say the line until it's right" pattern (including
 *     aborted prefixes) with zero model variance, always keeping the LAST take.
 *  2. AI: a model pass for paraphrased retakes the similarity check can't see.
 *     The model returns SEGMENT INDICES (not raw seconds — models are bad at
 *     emitting precise decimals), and every proposed removal is validated
 *     against the transcript before it's allowed to cut anything.
 *
 * Both layers emit word-precise SOURCE-time regions.
 */
import { runTask } from './router'
import { extractJson, isObject } from './json'
import { normalizeTokens, prefixSimilarity, tokenSimilarity } from './similarity'
import type { TimeRegion, Transcript, TranscriptSegment } from '@shared/types'

export interface RetakeRemoval extends TimeRegion {
  reason: string
}

/** Word-precise span of a segment (falls back to segment bounds). */
function segmentSpan(seg: TranscriptSegment): TimeRegion {
  const first = seg.words[0]?.start ?? seg.start
  const last = seg.words[seg.words.length - 1]?.end ?? seg.end
  return { start: Math.max(0, first - 0.05), end: last + 0.05 }
}

const LOOKAHEAD_SEGMENTS = 10
const LOOKAHEAD_SECONDS = 90
const DUPLICATE_SIM = 0.8
const PREFIX_SIM = 0.85
const MAX_SEGMENT_SEC = 25 // never auto-remove very long segments

/** Layer 1 — deterministic repeated-take detection. Keeps the LAST take. */
export function findRetakesDeterministic(transcript: Transcript): RetakeRemoval[] {
  const segs = transcript.segments
  const tokens = segs.map((s) => normalizeTokens(s.text))
  const removals: RetakeRemoval[] = []

  for (let i = 0; i < segs.length; i++) {
    const ti = tokens[i]
    if (ti.length < 3) continue // too short to match reliably ("Yeah." repeats naturally)
    if (segs[i].end - segs[i].start > MAX_SEGMENT_SEC) continue

    for (let j = i + 1; j < segs.length && j <= i + LOOKAHEAD_SEGMENTS; j++) {
      if (segs[j].start - segs[i].end > LOOKAHEAD_SECONDS) break
      const tj = tokens[j]
      if (tj.length === 0) continue
      const dup = tokenSimilarity(ti, tj) >= DUPLICATE_SIM
      const falseStart = tj.length > ti.length && prefixSimilarity(ti, tj) >= PREFIX_SIM
      if (dup || falseStart) {
        removals.push({
          ...segmentSpan(segs[i]),
          reason: dup ? `Repeated take — re-recorded at ${segs[j].start.toFixed(1)}s` : 'False start — line restarted and extended'
        })
        break // i is gone; whether j itself repeats is decided when i === j
      }
    }
  }
  return removals
}

/** Layer 2 — AI pass with segment-index protocol + validation. */
export async function findRetakesAI(transcript: Transcript, signal?: AbortSignal): Promise<RetakeRemoval[]> {
  const segs = transcript.segments
  const lines = segs.map((s, i) => `#${i} [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`).join('\n')

  const raw = await runTask(
    'retake-detection',
    {
      system:
        'TASK:retake-detection — You clean up raw talking-head footage. Speakers re-record lines until they get ' +
        'them right, and make false starts. From the numbered transcript, identify EARLIER attempts of content that ' +
        'is repeated (possibly reworded) later, keeping only the LAST take. ' +
        'Refer to lines ONLY by their #index. Respond with STRICT JSON: ' +
        '{"removals":[{"from":number,"to":number,"betterTake":number,"reason":string}]} where from..to is the ' +
        'inclusive index range to REMOVE and betterTake is the index of the kept later take. ' +
        'Be conservative — only clear retakes/restarts of the SAME content, never distinct sentences. ' +
        'Return {"removals":[]} if there are none.',
      user: `NUMBERED TRANSCRIPT:\n${lines}`,
      jsonSchemaHint: 'removals array',
      temperature: 0.1,
      maxTokens: 8192
    },
    signal
  )

  const parsed = extractJson(
    raw,
    (v): v is { removals: { from: number; to: number; betterTake?: number; reason?: string }[] } =>
      isObject(v) && Array.isArray((v as any).removals)
  )

  const removals: RetakeRemoval[] = []
  for (const r of parsed.removals) {
    const from = Math.trunc(r.from)
    const to = Math.trunc(r.to ?? r.from)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    if (from < 0 || to >= segs.length || to < from) continue
    if (to - from > 6) continue // huge ranges are almost certainly a model mistake

    // VALIDATE: the removed text must actually resemble a later kept take, or
    // be a short false start. Otherwise the model is deleting unique content.
    // Truncate ONCE and reuse — comparing the raw value while indexing the
    // truncated one would let betterTake=5.5 validate removal 5 against itself.
    const removedTokens = normalizeTokens(segs.slice(from, to + 1).map((s) => s.text).join(' '))
    const bt = typeof r.betterTake === 'number' ? Math.trunc(r.betterTake) : NaN
    const better = Number.isInteger(bt) && bt > to && bt < segs.length ? segs[bt] : undefined
    const betterTokens = better ? normalizeTokens(better.text) : null
    const resembles =
      betterTokens !== null &&
      (tokenSimilarity(removedTokens, betterTokens) >= 0.45 || prefixSimilarity(removedTokens, betterTokens) >= 0.6)
    const shortFalseStart = removedTokens.length <= 8
    if (!resembles && !shortFalseStart) continue

    const span = { start: segmentSpan(segs[from]).start, end: segmentSpan(segs[to]).end }
    if (span.end - span.start > 60) continue // sanity cap
    removals.push({ ...span, reason: r.reason || 'Earlier take of a repeated line' })
  }
  return removals
}

/** Merge overlapping removals from both layers. */
export function mergeRemovals(a: RetakeRemoval[], b: RetakeRemoval[]): RetakeRemoval[] {
  const all = [...a, ...b].sort((x, y) => x.start - y.start)
  const out: RetakeRemoval[] = []
  for (const r of all) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 0.05) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

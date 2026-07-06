/**
 * Time-domain mapping — THE one place that converts between the two
 * timelines the app deals with:
 *
 *  - SOURCE time: the original video. Cuts and the transcript live here.
 *  - TRIMMED time: after validated cuts are removed. The preview <video>,
 *    transitions, graphics, and music cues live here.
 *
 * Used by both the main process (render, revisions) and the renderer
 * (playhead, transcript seeking) so the conversions can never drift apart.
 */
import type { CutRegion, TimeRegion } from './types'

/** Invert validated cuts into keep-segments over [0, durationSec]. */
export function cutsToKeepSegments(cuts: CutRegion[], durationSec: number): TimeRegion[] {
  const active = cuts
    .filter((c) => c.status === 'validated')
    .slice()
    .sort((a, b) => a.start - b.start)
  const keep: TimeRegion[] = []
  let cursor = 0
  for (const c of active) {
    if (c.start > cursor) keep.push({ start: cursor, end: Math.min(c.start, durationSec) })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < durationSec) keep.push({ start: cursor, end: durationSec })
  return keep.filter((k) => k.end - k.start > 0.04)
}

/** Map a SOURCE-timeline second onto the TRIMMED timeline. Times inside a cut
 *  collapse to the cut point. */
export function sourceToTrimmedTime(t: number, keep: TimeRegion[]): number {
  let acc = 0
  for (const k of keep) {
    if (t <= k.start) return acc
    if (t <= k.end) return acc + (t - k.start)
    acc += k.end - k.start
  }
  return acc
}

/** Map a TRIMMED-timeline second back onto the SOURCE timeline. */
export function trimmedToSourceTime(t: number, keep: TimeRegion[]): number {
  let acc = 0
  for (const k of keep) {
    const len = k.end - k.start
    if (t <= acc + len) return k.start + (t - acc)
    acc += len
  }
  return keep.length > 0 ? keep[keep.length - 1].end : t
}


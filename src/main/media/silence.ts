/**
 * Stage 1 helper — silence detection via FFmpeg `silencedetect`.
 * Produces PROPOSED cut regions (data only, nothing is cut here).
 */
import { runFFmpeg } from './ffmpeg'
import { newId } from '@shared/id'
import type { CutRegion, TimeRegion, Transcript } from '@shared/types'

export interface SilenceOptions {
  thresholdDb: number // e.g. -35
  minSilenceSec: number // e.g. 0.6
  keepPadMs: number // ~150 — lead/tail retained so cuts don't feel clipped
}

/** Raw silence intervals from silencedetect stderr output. */
export async function detectSilence(
  filePath: string,
  opts: SilenceOptions,
  durationSec: number,
  signal?: AbortSignal
): Promise<TimeRegion[]> {
  const stderr = await runFFmpeg(
    [
      '-i', filePath,
      '-af', `silencedetect=noise=${opts.thresholdDb}dB:d=${opts.minSilenceSec}`,
      '-f', 'null', '-'
    ],
    { signal }
  )
  const regions: TimeRegion[] = []
  let pendingStart: number | null = null
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*([\d.]+)/)
    if (s) pendingStart = Number(s[1])
    const e = line.match(/silence_end:\s*([\d.]+)/)
    if (e && pendingStart !== null) {
      regions.push({ start: pendingStart, end: Number(e[1]) })
      pendingStart = null
    }
  }
  // Silence that runs to EOF emits silence_start with no silence_end — close it.
  if (pendingStart !== null && durationSec > pendingStart) {
    regions.push({ start: pendingStart, end: durationSec })
  }
  return regions
}

/**
 * Transcript-driven "silence" = the gaps BETWEEN spoken words. For talking-head
 * footage this is far more accurate than an audio-energy threshold: it keeps
 * exactly where words are and cuts the gaps, so there's no dB to tune. Returns
 * gap regions at least `minSilenceSec` long; feed them to silencesToCuts (which
 * applies the keep-pad buffer) exactly like audio silences.
 */
export function transcriptSilences(transcript: Transcript, durationSec: number, minSilenceSec: number): TimeRegion[] {
  // Flatten to word intervals (fall back to the segment span when a segment has
  // no per-word timings), sorted by start.
  const words: TimeRegion[] = []
  for (const seg of transcript.segments) {
    if (seg.words && seg.words.length > 0) {
      for (const w of seg.words) words.push({ start: w.start, end: w.end })
    } else {
      words.push({ start: seg.start, end: seg.end })
    }
  }
  words.sort((a, b) => a.start - b.start)
  if (words.length === 0) return []

  const gaps: TimeRegion[] = []
  if (words[0].start > 0) gaps.push({ start: 0, end: words[0].start }) // lead-in
  let cursor = words[0].end
  for (let i = 1; i < words.length; i++) {
    if (words[i].start > cursor) gaps.push({ start: cursor, end: words[i].start })
    cursor = Math.max(cursor, words[i].end)
  }
  if (durationSec > cursor) gaps.push({ start: cursor, end: durationSec }) // tail

  return gaps.filter((g) => g.end - g.start >= minSilenceSec)
}

/**
 * Convert silence intervals into proposed cuts, shrinking each region by the
 * keep-pad on both sides. Regions that collapse below 80ms are dropped.
 */
export function silencesToCuts(silences: TimeRegion[], opts: SilenceOptions): CutRegion[] {
  const pad = opts.keepPadMs / 1000
  const cuts: CutRegion[] = []
  for (const r of silences) {
    const start = r.start + pad
    const end = r.end - pad
    if (end - start < 0.08) continue
    cuts.push({
      id: newId('cut'),
      start,
      end,
      padMs: opts.keepPadMs,
      origin: 'pipeline',
      status: 'proposed'
    })
  }
  return cuts
}

// Keep-segment / time-domain math lives in @shared/timemap so the renderer
// uses the exact same conversions (playhead, transcript seeking).
export { cutsToKeepSegments, sourceToTrimmedTime } from '@shared/timemap'

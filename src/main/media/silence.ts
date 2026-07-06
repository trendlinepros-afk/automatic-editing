/**
 * Stage 1 helper — silence detection via FFmpeg `silencedetect`.
 * Produces PROPOSED cut regions (data only, nothing is cut here).
 */
import { runFFmpeg } from './ffmpeg'
import { newId } from '@shared/id'
import type { CutRegion, TimeRegion } from '@shared/types'

export interface SilenceOptions {
  thresholdDb: number // e.g. -35
  minSilenceSec: number // e.g. 0.6
  keepPadMs: number // ~150 — lead/tail retained so cuts don't feel clipped
}

/** Raw silence intervals from silencedetect stderr output. */
export async function detectSilence(
  filePath: string,
  opts: SilenceOptions,
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
  return regions
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

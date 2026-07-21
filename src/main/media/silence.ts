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
 * Transcript-driven dead-space cuts — derived from the gaps BETWEEN spoken
 * words, with NATURAL PAUSE SHAPING instead of a uniform machine-gun trim:
 *
 *  - Mid-sentence gaps keep a short beat (keep-pad each side).
 *  - Sentence-ending gaps (previous word ends with . ! ?) keep a longer breath
 *    (~1.8× pad) so pacing feels human, not chopped.
 *  - The lead-in keeps ~0.5s before the first word; the tail keeps ~1s after
 *    the last word.
 *  - A gap is only cut when cutting actually saves ≥0.2s — no pointless
 *    micro-cuts that add join artifacts without shortening the video.
 *
 * Far more accurate than an audio-dB threshold, and nothing to tune.
 */
export function transcriptGapCuts(
  transcript: Transcript,
  durationSec: number,
  opts: SilenceOptions
): CutRegion[] {
  interface Word extends TimeRegion {
    text: string
    /** True when this word ends a sentence. Whisper word tokens carry NO
     *  punctuation, so the last word of a segment inherits the segment text's
     *  ending — segments break at sentence-ish boundaries. */
    sentenceEnd: boolean
  }
  const words: Word[] = []
  for (const seg of transcript.segments) {
    const segEndsSentence = /[.!?]["')\]]?\s*$/.test(seg.text.trim())
    if (seg.words && seg.words.length > 0) {
      seg.words.forEach((w, i) => {
        const last = i === seg.words.length - 1
        words.push({
          start: w.start,
          end: w.end,
          text: w.word,
          sentenceEnd: /[.!?]["')\]]?\s*$/.test(w.word.trim()) || (last && segEndsSentence)
        })
      })
    } else {
      words.push({ start: seg.start, end: seg.end, text: seg.text, sentenceEnd: segEndsSentence })
    }
  }
  words.sort((a, b) => a.start - b.start)
  if (words.length === 0) return []

  const pad = Math.max(0.06, opts.keepPadMs / 1000)
  const minGap = Math.max(0.2, opts.minSilenceSec)
  const cuts: CutRegion[] = []
  const push = (start: number, end: number, note?: string) => {
    if (end - start >= 0.12) {
      cuts.push({ id: newId('cut'), start, end, padMs: opts.keepPadMs, origin: 'pipeline', status: 'proposed', kind: 'gap', note })
    }
  }

  // Lead-in: keep half a second of run-up before the first word.
  if (words[0].start > 1.0) push(0, words[0].start - 0.5, 'Lead-in before speech')

  let cursor = words[0].end
  let prevSentenceEnd = words[0].sentenceEnd
  for (let i = 1; i < words.length; i++) {
    const gapStart = cursor
    const gapEnd = words[i].start
    if (gapEnd - gapStart >= minGap) {
      // Sentence boundary → leave a longer breath; mid-sentence → tight beat.
      const tailPad = prevSentenceEnd ? pad * 1.8 : pad
      const leadPad = pad * 0.8 // Whisper word STARTS are accurate; tuck in close
      const cutStart = gapStart + tailPad
      const cutEnd = gapEnd - leadPad
      if (cutEnd - cutStart >= 0.2) push(cutStart, cutEnd)
    }
    if (words[i].end >= cursor) {
      cursor = words[i].end
      prevSentenceEnd = words[i].sentenceEnd
    }
  }

  // Tail: keep a one-second outro beat after the last word.
  if (durationSec - cursor > 1.5) push(cursor + 1.0, durationSec, 'Tail after speech')
  return cuts
}

/**
 * Post-process a proposed cut list so the resulting keeps play smoothly:
 *  - overlapping cuts merge;
 *  - cuts separated by a keep sliver shorter than `minKeepSec` merge THROUGH
 *    the sliver (a 0.2s fragment of a half-word is jarring — cutting it reads
 *    better than keeping it);
 *  - cuts below 0.12s are dropped (join artifact costs more than it saves).
 * Only pass PIPELINE-proposed cuts through this — never rewrite manual edits.
 */
export function refineCuts(cuts: CutRegion[], minKeepSec = 0.3): CutRegion[] {
  const sorted = cuts.slice().sort((a, b) => a.start - b.start)
  const merged: CutRegion[] = []
  for (const c of sorted) {
    const last = merged[merged.length - 1]
    const sliver = last ? c.start - last.end : Infinity
    // NEVER merge two retake cuts across a positive keep: the material between
    // consecutive retake removals IS the kept take (possibly a very short
    // line) — merging through it would delete the only surviving copy, and
    // the merged 'retake' cut would bypass stage-2 review. Overlaps still
    // merge; retake↔gap merges are safe (the sliver is inside a word gap).
    const bothRetake = last?.kind === 'retake' && c.kind === 'retake'
    if (last && (sliver <= 0 || (sliver < minKeepSec && !bothRetake))) {
      last.end = Math.max(last.end, c.end)
      if (c.note && !last.note) last.note = c.note
      // A merge that includes retake material contains intentional speech —
      // it must not be re-judged as a silence cut by the stage-2 reviewer.
      if (c.kind === 'retake') last.kind = 'retake'
    } else {
      merged.push({ ...c })
    }
  }
  return merged.filter((c) => c.end - c.start >= 0.12)
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

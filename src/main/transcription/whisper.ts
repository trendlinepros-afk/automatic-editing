/**
 * Transcription — pinned to the OpenAI Whisper API (not part of the swappable
 * AI routing). This is the one metered call that scales with video length, so
 * estimateCost() is surfaced in the UI before long files run.
 *
 * Keyless runs get a mock transcript so the rest of the pipeline still works.
 */
import fs from 'fs'
import path from 'path'
import { runFFmpeg } from '../media/ffmpeg'
import { apiError } from '../net'
import { getSettingsStore } from '../settings'
import { log } from '../log'
import { newId } from '@shared/id'
import type { Transcript, TranscriptSegment } from '@shared/types'

const WHISPER_USD_PER_MIN = 0.006

export function estimateCost(durationSec: number): { minutes: number; estUsd: number } {
  const minutes = Math.ceil(durationSec / 60)
  return { minutes, estUsd: Number((minutes * WHISPER_USD_PER_MIN).toFixed(3)) }
}

export async function transcribe(
  sourcePath: string,
  workDir: string,
  durationSec: number,
  signal?: AbortSignal,
  onProgress?: (f: number) => void
): Promise<Transcript> {
  const key = getSettingsStore().getSecret('openai')
  if (!key) {
    log.warn('whisper', 'no OpenAI key — returning MOCK transcript (retakes/gap-cuts will be inert)')
    return mockTranscript(durationSec)
  }
  log.info('whisper', `transcribing ${sourcePath} (${(durationSec / 60).toFixed(1)} min) via openai/whisper-1`)

  // Extract mono 16k audio — smaller upload, same accuracy.
  const audioPath = path.join(workDir, 'transcribe-audio.mp3')
  onProgress?.(0.05)
  await runFFmpeg(
    ['-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audioPath],
    { signal, totalSec: durationSec, onProgress: (f) => onProgress?.(0.05 + f * 0.25) }
  )

  const form = new FormData()
  const buf = fs.readFileSync(audioPath)
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3')
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  form.append('timestamp_granularities[]', 'word')

  onProgress?.(0.35)
  log.info('whisper', `uploading ${(buf.length / 1024 / 1024).toFixed(1)} MB audio to OpenAI`)
  const t0 = Date.now()
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${key}` },
    body: form
  })
  if (!res.ok) {
    log.error('whisper', `openai/whisper-1 responded ${res.status} after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    throw await apiError('OpenAI Whisper (whisper-1)', res)
  }
  const json: any = await res.json()
  log.info('whisper', `ok in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${json.segments?.length ?? 0} segments, ${json.words?.length ?? 0} words, lang=${json.language}`)
  onProgress?.(0.95)

  const words: { word: string; start: number; end: number }[] = json.words ?? []
  const segments: TranscriptSegment[] = (json.segments ?? []).map((s: any) => ({
    id: newId('seg'),
    start: Number(s.start),
    end: Number(s.end),
    text: String(s.text ?? '').trim(),
    words: words
      .filter((w) => w.start >= Number(s.start) - 0.05 && w.end <= Number(s.end) + 0.05)
      .map((w) => ({ word: w.word, start: w.start, end: w.end }))
  }))

  return {
    language: String(json.language ?? 'en'),
    durationSec: Number(json.duration ?? durationSec),
    segments,
    source: 'whisper'
  }
}

function mockTranscript(durationSec: number): Transcript {
  const lines = [
    'Welcome back to the channel, today we are testing Zirtola.',
    'This transcript is mock data because no OpenAI key is configured.',
    'Add your key in Settings to run real Whisper transcription.',
    'The pipeline still runs end to end so you can explore the review loop.',
    'Try selecting this sentence and asking for a tighter cut.'
  ]
  const segLen = Math.min(6, durationSec / lines.length || 6)
  const segments: TranscriptSegment[] = lines.map((text, i) => {
    const start = i * segLen
    const end = Math.min(start + segLen - 0.4, durationSec || start + segLen - 0.4)
    const wordsArr = text.split(' ')
    const per = (end - start) / wordsArr.length
    return {
      id: newId('seg'),
      start,
      end,
      text,
      words: wordsArr.map((w, wi) => ({ word: w, start: start + wi * per, end: start + (wi + 1) * per }))
    }
  })
  return { language: 'en', durationSec, segments, source: 'mock' }
}

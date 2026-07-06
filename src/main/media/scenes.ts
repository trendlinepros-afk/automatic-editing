/**
 * Stage 3 helper — major scene-change detection on the TRIMMED video.
 * Uses FFmpeg's scene score with showinfo; only strong changes become
 * transition candidates so micro-cuts stay clean.
 */
import { runFFmpeg } from './ffmpeg'

export async function detectSceneChanges(
  filePath: string,
  threshold: number, // 0..1; ~0.4 = major changes only
  signal?: AbortSignal
): Promise<number[]> {
  const stderr = await runFFmpeg(
    [
      '-i', filePath,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-f', 'null', '-'
    ],
    { signal }
  )
  const times: number[] = []
  for (const line of stderr.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/)
    if (m) times.push(Number(m[1]))
  }
  // De-duplicate boundaries closer than 2s — one transition per real change.
  const out: number[] = []
  for (const t of times) {
    if (out.length === 0 || t - out[out.length - 1] > 2) out.push(t)
  }
  return out
}

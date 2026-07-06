/**
 * Build one working video from an ordered list of clips.
 *
 * The clips are referenced in place (never copied). A single clip is used
 * directly. Uniform clips (same dimensions/fps/audio — e.g. from one camera)
 * are concatenated losslessly with a stream copy. Mixed formats are re-encoded
 * with normalization (scale/pad/fps + audio format) so the concat is clean.
 */
import fs from 'fs'
import path from 'path'
import { runFFmpeg, probe, type RunOptions } from './ffmpeg'

export async function buildSequence(workDir: string, clips: string[], opts: RunOptions = {}): Promise<string> {
  if (clips.length === 0) throw new Error('No clips to sequence.')
  // One clip: edit it in place, no concat, no copy.
  if (clips.length === 1) return clips[0]

  for (const c of clips) {
    if (!fs.existsSync(c)) throw new Error(`Clip not found: ${c}. Re-import it and try again.`)
  }

  const infos = await Promise.all(clips.map((p) => probe(p)))
  const first = infos[0]
  const uniform = infos.every(
    (i) =>
      i.width === first.width &&
      i.height === first.height &&
      Math.abs(i.fps - first.fps) < 0.05 &&
      i.hasAudio === first.hasAudio
  )
  const totalSec = infos.reduce((a, i) => a + i.durationSec, 0)
  const out = path.join(workDir, 'sequence.mp4')

  if (uniform) {
    // Lossless concat via the demuxer. Requires a list file of absolute paths.
    const listFile = path.join(workDir, 'concat-list.txt')
    const esc = (p: string) => p.replace(/'/g, "'\\''")
    fs.writeFileSync(listFile, clips.map((p) => `file '${esc(path.resolve(p))}'`).join('\n'))
    await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out], { ...opts, totalSec })
    return out
  }

  // Mixed formats: normalize every clip to the first clip's frame + a common
  // audio format, injecting silent audio where a clip has none, then concat.
  const W = first.width
  const H = first.height
  const fps = Math.round(first.fps) || 30
  const inputs = clips.flatMap((p) => ['-i', p])
  const parts: string[] = []
  const labels: string[] = []
  infos.forEach((info, i) => {
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`
    )
    if (info.hasAudio) {
      parts.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`)
    } else {
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${info.durationSec.toFixed(3)}[a${i}]`)
    }
    labels.push(`[v${i}][a${i}]`)
  })
  const filter = `${parts.join(';')};${labels.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`
  await runFFmpeg(
    [
      ...inputs,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      out
    ],
    { ...opts, totalSec }
  )
  return out
}

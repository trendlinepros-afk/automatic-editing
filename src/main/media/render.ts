/**
 * Render operations: apply cuts, transitions, graphic compositing, audio mix,
 * preview export, and final export. Each writes an intermediate into the
 * project work dir; the source file is never touched.
 */
import path from 'path'
import fs from 'fs'
import { runFFmpeg, hasNvenc, type RunOptions } from './ffmpeg'
import { cutsToKeepSegments } from './silence'
import type { EDL, ExportPreset, Project, TimeRegion, TransitionEvent } from '@shared/types'

// ---------------------------------------------------------------------------
// Stage 2 output — apply validated cuts → trimmed.mp4
// ---------------------------------------------------------------------------

export async function applyCuts(
  project: Project,
  opts: RunOptions
): Promise<{ outPath: string; keep: TimeRegion[] }> {
  const keep = cutsToKeepSegments(project.edl.cuts, project.source.durationSec)
  const outPath = path.join(project.workDir, 'trimmed.mp4')
  if (keep.length === 0) throw new Error('Cut list removes the entire video — nothing left to keep.')

  // Build a select/aselect filter over keep segments; re-encodes once, keeps
  // A/V in sync, avoids N intermediate files.
  const expr = keep.map((k) => `between(t,${k.start.toFixed(3)},${k.end.toFixed(3)})`).join('+')
  await runFFmpeg(
    [
      '-i', project.source.path,
      '-vf', `select='${expr}',setpts=N/FRAME_RATE/TB`,
      '-af', `aselect='${expr}',asetpts=N/SR/TB`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
      '-c:a', 'aac', '-b:a', '192k',
      outPath
    ],
    { ...opts, totalSec: keep.reduce((a, k) => a + (k.end - k.start), 0) }
  )
  return { outPath, keep }
}

// ---------------------------------------------------------------------------
// Stage 3 output — bake transitions at major boundaries → transitions.mp4
// ---------------------------------------------------------------------------

export async function applyTransitions(
  project: Project,
  inPath: string,
  opts: RunOptions
): Promise<string> {
  const transitions = project.edl.transitions
  const outPath = path.join(project.workDir, 'transitions.mp4')
  if (transitions.length === 0) {
    fs.copyFileSync(inPath, outPath)
    return outPath
  }
  // Dip-to-black is rendered as brief fades around each boundary; crossfade at
  // a hard boundary of an already-joined file is approximated the same way
  // (real crossfade would need the pre-join segments — tracked in the EDL for
  // a future segment-wise renderer).
  const fades: string[] = []
  for (const t of transitions) {
    const half = t.durationSec / 2
    fades.push(`fade=t=out:st=${(t.at - half).toFixed(3)}:d=${half.toFixed(3)}`)
    fades.push(`fade=t=in:st=${t.at.toFixed(3)}:d=${half.toFixed(3)}`)
  }
  await runFFmpeg(
    [
      '-i', inPath,
      '-vf', fades.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
      '-c:a', 'copy',
      outPath
    ],
    opts
  )
  return outPath
}

// ---------------------------------------------------------------------------
// Stage 4 output — composite rendered alpha-MP4 graphics → graphics.mp4
// ---------------------------------------------------------------------------

export async function compositeGraphics(
  project: Project,
  inPath: string,
  opts: RunOptions
): Promise<string> {
  const rendered = project.edl.graphics.filter((g) => g.status === 'rendered' && g.renderPath)
  const outPath = path.join(project.workDir, 'graphics.mp4')
  if (rendered.length === 0) {
    fs.copyFileSync(inPath, outPath)
    return outPath
  }
  const inputs: string[] = ['-i', inPath]
  for (const g of rendered) inputs.push('-i', g.renderPath!)

  let chain = ''
  let prev = '[0:v]'
  rendered.forEach((g, i) => {
    const idx = i + 1
    const label = i === rendered.length - 1 ? '[vout]' : `[v${idx}]`
    chain +=
      `${prev}[${idx}:v]overlay=0:0:enable='between(t,${g.at.toFixed(3)},${(g.at + g.durationSec).toFixed(3)})'` +
      `${label};`
    prev = `[v${idx}]`
  })
  chain = chain.slice(0, -1)

  await runFFmpeg(
    [
      ...inputs,
      '-filter_complex', chain,
      '-map', '[vout]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
      '-c:a', 'copy',
      outPath
    ],
    opts
  )
  return outPath
}

// ---------------------------------------------------------------------------
// Stage 5 output — SFX + music with auto-ducking → mixed.mp4
// ---------------------------------------------------------------------------

export async function mixAudio(
  project: Project,
  inPath: string,
  speechRegions: TimeRegion[],
  opts: RunOptions
): Promise<string> {
  const { music, sfx } = project.edl
  const outPath = path.join(project.workDir, 'mixed.mp4')
  if (music.length === 0 && sfx.length === 0) {
    fs.copyFileSync(inPath, outPath)
    return outPath
  }

  const inputs: string[] = ['-i', inPath]
  const chains: string[] = []
  const mixLabels: string[] = ['[0:a]']
  let inputIdx = 1

  for (const cue of music) {
    inputs.push('-i', cue.filePath)
    // Duck under speech: volume automation via the transcript's speech regions.
    const duckExpr = speechRegions
      .map((r) => `between(t,${r.start.toFixed(2)},${r.end.toFixed(2)})`)
      .join('+')
    const duckGain = duckExpr
      ? `volume=volume='if(${duckExpr},${dbToLinear(cue.gainDb + cue.duckDb)},${dbToLinear(cue.gainDb)})':eval=frame`
      : `volume=${dbToLinear(cue.gainDb)}`
    chains.push(
      `[${inputIdx}:a]atrim=0:${(cue.region.end - cue.region.start).toFixed(2)},` +
        `adelay=${Math.round(cue.region.start * 1000)}|${Math.round(cue.region.start * 1000)},` +
        `afade=t=in:d=${cue.fadeInSec},afade=t=out:st=${Math.max(0, cue.region.end - cue.region.start - cue.fadeOutSec).toFixed(2)}:d=${cue.fadeOutSec},` +
        `${duckGain}[m${inputIdx}]`
    )
    mixLabels.push(`[m${inputIdx}]`)
    inputIdx++
  }

  for (const s of sfx) {
    inputs.push('-i', s.filePath)
    chains.push(
      `[${inputIdx}:a]adelay=${Math.round(s.at * 1000)}|${Math.round(s.at * 1000)},volume=${dbToLinear(s.gainDb)}[m${inputIdx}]`
    )
    mixLabels.push(`[m${inputIdx}]`)
    inputIdx++
  }

  const filter =
    chains.join(';') +
    `;${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[aout]`

  await runFFmpeg(
    [
      ...inputs,
      '-filter_complex', filter,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      outPath
    ],
    opts
  )
  return outPath
}

function dbToLinear(db: number): string {
  return Math.pow(10, db / 20).toFixed(4)
}

// ---------------------------------------------------------------------------
// Stage 6 — low-res preview; and final export with captions
// ---------------------------------------------------------------------------

export async function exportPreview(
  project: Project,
  inPath: string,
  assPath: string | null,
  opts: RunOptions
): Promise<string> {
  const outPath = path.join(project.workDir, 'preview.mp4')
  const nvenc = await hasNvenc()
  const vf: string[] = ['scale=-2:540']
  if (assPath) vf.push(`ass='${escapeFilterPath(assPath)}'`)
  await runFFmpeg(
    [
      '-i', inPath,
      '-vf', vf.join(','),
      ...(nvenc
        ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '32']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30']),
      '-c:a', 'aac', '-b:a', '128k',
      outPath
    ],
    opts
  )
  return outPath
}

export async function exportFinal(
  project: Project,
  inPath: string,
  assPath: string | null,
  preset: ExportPreset,
  opts: RunOptions
): Promise<string> {
  const outPath = path.join(project.workDir, `final-${preset.id}.mp4`)
  const nvenc = await hasNvenc()
  const vf: string[] = [
    // Fit-and-pad to the preset canvas (vertical preset crops via scale+pad).
    `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease`,
    `pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2:color=black`
  ]
  if (assPath) vf.push(`ass='${escapeFilterPath(assPath)}'`)
  await runFFmpeg(
    [
      '-i', inPath,
      '-vf', vf.join(','),
      ...(nvenc && preset.videoCodec === 'h264'
        ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', String(preset.crf + 4)]
        : ['-c:v', preset.videoCodec === 'hevc' ? 'libx265' : 'libx264', '-preset', 'medium', '-crf', String(preset.crf)]),
    '-c:a', 'aac', '-b:a', '256k',
      '-movflags', '+faststart',
      outPath
    ],
    opts
  )
  return outPath
}

/** Windows paths need escaping inside filter strings (C\:/path style). */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

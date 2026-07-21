/**
 * Render operations: apply cuts, transitions, graphic compositing, audio mix,
 * preview export, and final export. Each writes an intermediate into the
 * project work dir; the source file is never touched.
 */
import path from 'path'
import fs from 'fs'
import { runFFmpeg, hasNvenc, type RunOptions } from './ffmpeg'
import { getSettingsStore } from '../settings'
import { cutsToKeepSegments, sourceToTrimmedTime } from '@shared/timemap'
import type { ExportPreset, Project, SourceInfo, TimeRegion } from '@shared/types'

/** A project can exist before footage is attached; render paths require it. */
export function requireSource(project: Project): SourceInfo {
  if (!project.source) throw new Error('Attach a source video to this project before running the pipeline.')
  return project.source
}

/** NVENC is used only when available AND the user's preference allows it. */
async function useNvenc(): Promise<boolean> {
  return getSettingsStore().getSettings().export.preferNvenc && (await hasNvenc())
}

// ---------------------------------------------------------------------------
// Stage 2 output — apply validated cuts → trimmed.mp4
// ---------------------------------------------------------------------------

export async function applyCuts(
  project: Project,
  opts: RunOptions
): Promise<{ outPath: string; keep: TimeRegion[] }> {
  const source = requireSource(project)
  const keep = cutsToKeepSegments(project.edl.cuts, source.durationSec)
  const outPath = path.join(project.workDir, 'trimmed.mp4')
  if (keep.length === 0) throw new Error('Cut list removes the entire video — nothing left to keep.')

  // Segment-wise trim + concat, with a ~12ms audio fade at each join so cuts
  // never click or pop (hard sample-cuts at arbitrary offsets are audible).
  // The graph is written to a filter_complex_script file: with hundreds of
  // keep segments an inline -filter_complex would blow the Windows
  // command-line length limit.
  const n = keep.length
  const FADE = 0.012
  const lines: string[] = []
  const vs = Array.from({ length: n }, (_, i) => `[vs${i}]`)
  lines.push(`[0:v]split=${n}${vs.join('')}`)
  if (source.hasAudio) {
    const as = Array.from({ length: n }, (_, i) => `[as${i}]`)
    lines.push(`[0:a]asplit=${n}${as.join('')}`)
  }
  keep.forEach((k, i) => {
    const dur = k.end - k.start
    lines.push(`[vs${i}]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`)
    if (source.hasAudio) {
      const fadeOutSt = Math.max(0, dur - FADE)
      lines.push(
        `[as${i}]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `afade=t=in:d=${FADE},afade=t=out:st=${fadeOutSt.toFixed(3)}:d=${FADE}[a${i}]`
      )
    }
  })
  const pairs = keep.map((_, i) => (source.hasAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('')
  lines.push(
    source.hasAudio
      ? `${pairs}concat=n=${n}:v=1:a=1[vout][aout]`
      : `${pairs}concat=n=${n}:v=1:a=0[vout]`
  )
  const scriptPath = path.join(project.workDir, 'cuts-filter.txt')
  fs.writeFileSync(scriptPath, lines.join(';\n'))

  const args = [
    '-i', source.path,
    '-filter_complex_script', scriptPath,
    '-map', '[vout]',
    ...(source.hasAudio ? ['-map', '[aout]'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
    ...(source.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    outPath
  ]
  await runFFmpeg(args, { ...opts, totalSec: keep.reduce((a, k) => a + (k.end - k.start), 0) })
  return { outPath, keep }
}

// ---------------------------------------------------------------------------
// Stage 3 output — bake transitions at major boundaries → transitions.mp4
// ---------------------------------------------------------------------------

export async function applyTransitions(
  project: Project,
  inPath: string,
  keep: TimeRegion[],
  opts: RunOptions
): Promise<string> {
  // EDL stores transitions in SOURCE time; the video being faded is trimmed.
  const transitions = project.edl.transitions.map((t) => ({
    ...t,
    at: sourceToTrimmedTime(t.at, keep)
  }))
  const outPath = path.join(project.workDir, 'transitions.mp4')
  if (transitions.length === 0) {
    fs.copyFileSync(inPath, outPath)
    return outPath
  }
  // Each transition is a short black clip with an alpha fade in/out overlaid
  // at the boundary (a dip-to-black). NOTE: plain `fade` filters can NOT be
  // chained for mid-video dips — fade-in holds black for every frame before
  // its start and fade-out after its end, so one transition would black out
  // the entire video. Overlaying self-contained faded clips composes safely.
  // Crossfade at a hard boundary of an already-joined file is approximated
  // the same way (a true crossfade needs the pre-join segments — tracked in
  // the EDL for a future segment-wise renderer).
  const { width, height } = requireSource(project)
  const parts: string[] = []
  let prev = '[0:v]'
  transitions.forEach((t, i) => {
    const dur = t.durationSec
    const half = dur / 2
    const start = Math.max(0, t.at - half)
    parts.push(
      `color=black:s=${width}x${height}:d=${dur.toFixed(3)}[b${i}]`,
      `[b${i}]format=yuva420p,fade=t=in:st=0:d=${half.toFixed(3)}:alpha=1,` +
        `fade=t=out:st=${half.toFixed(3)}:d=${half.toFixed(3)}:alpha=1,` +
        `setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[f${i}]`
    )
    const label = i === transitions.length - 1 ? '[vout]' : `[t${i}]`
    parts.push(`${prev}[f${i}]overlay=0:0:eof_action=pass${label}`)
    prev = `[t${i}]`
  })

  await runFFmpeg(
    [
      '-i', inPath,
      '-filter_complex', parts.join(';'),
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
// Stage 4 output — composite rendered alpha-MP4 graphics → graphics.mp4
// ---------------------------------------------------------------------------

export async function compositeGraphics(
  project: Project,
  inPath: string,
  keep: TimeRegion[],
  opts: RunOptions
): Promise<string> {
  // EDL stores graphic anchors in SOURCE time; convert to the trimmed
  // timeline of the video being composited. Graphics whose anchor falls
  // inside a cut collapse to the cut point and still show.
  const rendered = project.edl.graphics
    .filter((g) => g.status === 'rendered' && g.renderPath)
    .map((g) => ({ ...g, at: sourceToTrimmedTime(g.at, keep) }))
  const outPath = path.join(project.workDir, 'graphics.mp4')
  if (rendered.length === 0) {
    fs.copyFileSync(inPath, outPath)
    return outPath
  }
  const inputs: string[] = ['-i', inPath]
  for (const g of rendered) inputs.push('-i', g.renderPath!)

  // Each overlay input must be time-shifted to its placement (setpts) or its
  // frames play at t=0..dur and the enable window would only ever show the
  // frozen last frame. eof_action=pass drops the overlay once the clip ends.
  // Overlays are authored at 1920×1080 — scale to FIT the base video while
  // preserving aspect (never stretch: a vertical source would distort text
  // ~3.5×), then anchor: lower-thirds to the bottom edge, cards centered.
  // On a 16:9 base the scaled overlay fills the frame exactly (as before).
  const { width: bw, height: bh } = requireSource(project)
  const parts: string[] = []
  let prev = '[0:v]'
  rendered.forEach((g, i) => {
    const idx = i + 1
    const label = i === rendered.length - 1 ? '[vout]' : `[v${idx}]`
    parts.push(
      `[${idx}:v]scale=${bw}:${bh}:force_original_aspect_ratio=decrease,` +
        `setpts=PTS-STARTPTS+${g.at.toFixed(3)}/TB[g${idx}]`
    )
    const yExpr = g.templateId === 'lower-third' ? 'main_h-overlay_h' : '(main_h-overlay_h)/2'
    parts.push(
      `${prev}[g${idx}]overlay=(main_w-overlay_w)/2:${yExpr}:eof_action=pass:enable='between(t,${g.at.toFixed(3)},${(g.at + g.durationSec).toFixed(3)})'${label}`
    )
    prev = `[v${idx}]`
  })
  const chain = parts.join(';')

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
  keep: TimeRegion[],
  speechRegions: TimeRegion[],
  opts: RunOptions
): Promise<string> {
  // EDL stores music/SFX in SOURCE time; convert to trimmed time and drop cues
  // that collapsed to zero length (region fully inside a cut).
  const AFMT = 'aformat=sample_rates=48000:channel_layouts=stereo'
  const music = project.edl.music
    .map((m) => ({
      ...m,
      region: {
        start: sourceToTrimmedTime(m.region.start, keep),
        end: sourceToTrimmedTime(m.region.end, keep)
      }
    }))
    .filter((m) => m.region.end - m.region.start > 0.05)
  const sfx = project.edl.sfx.map((s) => ({ ...s, at: sourceToTrimmedTime(s.at, keep) }))
  const outPath = path.join(project.workDir, 'mixed.mp4')
  if ((music.length === 0 && sfx.length === 0) || !project.source?.hasAudio) {
    // Nothing to mix (or the base has no audio to mix onto) — pass through.
    fs.copyFileSync(inPath, outPath)
    return outPath
  }

  const inputs: string[] = ['-i', inPath]
  // Normalize every mix input to the same rate/layout so amix negotiates
  // cleanly regardless of the source assets' formats.
  const chains: string[] = [`[0:a]${AFMT}[base]`]
  const mixLabels: string[] = ['[base]']
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
    // Order matters: normalize + trim + fade in CUE-LOCAL time first, THEN
    // delay into place, THEN duck (duck expressions are in output-timeline time).
    const cueLen = cue.region.end - cue.region.start
    const delayMs = Math.round(cue.region.start * 1000)
    chains.push(
      `[${inputIdx}:a]${AFMT},atrim=0:${cueLen.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:d=${cue.fadeInSec},afade=t=out:st=${Math.max(0, cueLen - cue.fadeOutSec).toFixed(2)}:d=${cue.fadeOutSec},` +
        `adelay=${delayMs}|${delayMs},` +
        `${duckGain}[m${inputIdx}]`
    )
    mixLabels.push(`[m${inputIdx}]`)
    inputIdx++
  }

  for (const s of sfx) {
    inputs.push('-i', s.filePath)
    const ms = Math.round(s.at * 1000)
    chains.push(`[${inputIdx}:a]${AFMT},adelay=${ms}|${ms},volume=${dbToLinear(s.gainDb)}[m${inputIdx}]`)
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
  const nvenc = await useNvenc()
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
      // Move the moov atom to the front so the <video> element can start
      // playing / seeking immediately over the wcmedia stream.
      '-movflags', '+faststart',
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
  const nvenc = await useNvenc()
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

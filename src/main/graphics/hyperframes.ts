/**
 * HyperFrames integration — renders template HTML to MP4-with-alpha via the
 * HyperFrames CLI (headless-Chrome pipeline, local machine). This is the ONLY
 * graphics generation path; there is no cloud graphics API.
 *
 * Prereq: `npm i -g hyperframes` (or a local install) so `hyperframes` (or
 * `npx hyperframes`) resolves. When the CLI is missing we fall back to
 * rendering a still of the HTML via ffmpeg-less placeholder generation so the
 * pipeline still completes — clearly marked as a placeholder.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { runFFmpeg } from '../media/ffmpeg'
import { TEMPLATE_LIBRARY } from './templates'
import type { BrandKit, GraphicEvent } from '@shared/types'

let cliAvailable: boolean | null = null

const HYPERFRAMES_CMD = process.platform === 'win32' ? 'hyperframes.cmd' : 'hyperframes'

/**
 * The CLI resolves via the shell (needed for .cmd shims on Windows), so every
 * argument must be quoted — Windows user-profile paths contain spaces
 * (C:\Users\John Smith\AppData\...).
 */
function quoteArgs(args: string[]): string[] {
  return args.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
}

async function hyperframesAvailable(): Promise<boolean> {
  if (cliAvailable !== null) return cliAvailable
  cliAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn(HYPERFRAMES_CMD, ['--version'], {
      windowsHide: true,
      shell: true
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
  return cliAvailable
}

export interface HyperFramesResult {
  renderPath: string
  placeholder: boolean
}

/**
 * Render one graphic event to an alpha MP4 in the project work dir.
 * Writes the composed HTML next to the render for debuggability.
 */
export async function renderGraphic(
  workDir: string,
  graphic: GraphicEvent,
  brand: BrandKit,
  signal?: AbortSignal,
  onProgress?: (f: number) => void
): Promise<HyperFramesResult> {
  const template = TEMPLATE_LIBRARY[graphic.templateId]
  if (!template) throw new Error(`Unknown template "${graphic.templateId}".`)

  const gfxDir = path.join(workDir, 'graphics')
  fs.mkdirSync(gfxDir, { recursive: true })
  const htmlPath = path.join(gfxDir, `${graphic.id}.html`)
  const outPath = path.join(gfxDir, `${graphic.id}.mov`)
  fs.writeFileSync(htmlPath, template.html(graphic.slots, brand), 'utf-8')

  if (await hyperframesAvailable()) {
    await new Promise<void>((resolve, reject) => {
      const args = quoteArgs([
        'render', htmlPath,
        '--out', outPath,
        '--width', '1920', '--height', '1080',
        '--fps', '30',
        '--duration', String(graphic.durationSec),
        '--alpha'
      ])
      const child = spawn(HYPERFRAMES_CMD, args, {
        windowsHide: true,
        shell: true
      })
      let stderr = ''
      const onAbort = () => child.kill('SIGKILL')
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', (e) => reject(new Error(`HyperFrames failed to start: ${e.message}`)))
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) reject(new Error('Canceled'))
        else if (code === 0) resolve()
        else reject(new Error(`HyperFrames exited ${code}: ${stderr.slice(-400)}`))
      })
    })
    onProgress?.(1)
    return { renderPath: outPath, placeholder: false }
  }

  // Placeholder path: HyperFrames not installed. Generate a labeled
  // semi-transparent slate so compositing and review still work end-to-end.
  const label = `${template.id} (placeholder - install HyperFrames)`
  await runFFmpeg(
    [
      '-f', 'lavfi',
      '-i', `color=c=0x1c2128@0.75:s=1920x1080:d=${graphic.durationSec},format=yuva420p`,
      '-vf',
      `drawtext=text='${label.replace(/'/g, '')}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-c:v', 'qtrle',
      outPath.replace(/\.mov$/, '.placeholder.mov')
    ],
    { signal }
  ).catch(() => {
    // drawtext may be unavailable in some ffmpeg builds; plain slate fallback
    return runFFmpeg(
      [
        '-f', 'lavfi',
        '-i', `color=c=0x1c2128@0.75:s=1920x1080:d=${graphic.durationSec},format=yuva420p`,
        '-c:v', 'qtrle',
        outPath.replace(/\.mov$/, '.placeholder.mov')
      ],
      { signal }
    )
  })
  onProgress?.(1)
  return { renderPath: outPath.replace(/\.mov$/, '.placeholder.mov'), placeholder: true }
}

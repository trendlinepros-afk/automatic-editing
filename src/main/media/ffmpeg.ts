/**
 * FFmpeg/FFprobe subprocess wrapper.
 *
 * Every long-running invocation goes through runFFmpeg(), which reports
 * progress (parsed from -progress pipe:1) and honors an AbortSignal so the
 * render queue can cancel it (kills the child process).
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { log } from '../log'
import type { SourceInfo } from '@shared/types'

function resolveBin(mod: string, fallbackName: string): string {
  try {
    // ffmpeg-static exports the path directly; ffprobe-static exports { path }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require(mod)
    let p: string | undefined = typeof m === 'string' ? m : m?.path
    // Binaries inside app.asar cannot be spawned — electron-builder unpacks
    // them (asarUnpack in package.json); rewrite the path accordingly.
    if (p) p = p.replace(/\bapp\.asar([\\/])/, 'app.asar.unpacked$1')
    if (p && existsSync(p)) return p
  } catch {
    /* fall through to PATH lookup */
  }
  return fallbackName // rely on PATH
}

export const FFMPEG_BIN = resolveBin('ffmpeg-static', 'ffmpeg')
export const FFPROBE_BIN = resolveBin('ffprobe-static', 'ffprobe')

export interface RunOptions {
  signal?: AbortSignal
  /** Total seconds of expected output, for progress calculation. */
  totalSec?: number
  onProgress?: (fraction: number) => void
}

export class FFmpegError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderrTail: string
  ) {
    super(message)
  }
}

let ffmpegRunSeq = 0

/** Run ffmpeg with args; resolves on exit 0, rejects with stderr tail otherwise. */
export function runFFmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-y', ...args]
    if (opts.onProgress) fullArgs.push('-progress', 'pipe:1', '-nostats')

    const runId = ++ffmpegRunSeq
    const startedAt = Date.now()
    const cmdLine = fullArgs.join(' ')
    log.info('ffmpeg', `#${runId} start: ffmpeg ${cmdLine.length > 1500 ? cmdLine.slice(0, 1500) + '…[truncated]' : cmdLine}`)

    const child = spawn(FFMPEG_BIN, fullArgs, { windowsHide: true })
    let stderr = ''
    let stdoutTail = '' // only the trailing partial line — never the full stream

    const onAbort = () => child.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 65536) stderr = stderr.slice(-32768)
    })
    child.stdout.on('data', (d) => {
      // Parse each -progress chunk incrementally; keep only the partial line.
      const text = stdoutTail + d.toString()
      const lines = text.split('\n')
      stdoutTail = lines.pop() ?? ''
      if (stdoutTail.length > 4096) stdoutTail = '' // defensive cap
      if (opts.onProgress && opts.totalSec) {
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/^out_time_us=(\d+)/)
          if (m) {
            opts.onProgress(Math.min(1, Number(m[1]) / 1_000_000 / opts.totalSec))
            break
          }
        }
      }
    })
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      log.error('ffmpeg', `#${runId} failed to start: ${err.message}`)
      reject(new FFmpegError(`ffmpeg failed to start: ${err.message}`, null, ''))
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
      if (opts.signal?.aborted) {
        log.warn('ffmpeg', `#${runId} canceled after ${secs}s`)
        reject(new FFmpegError('Canceled', code, ''))
      } else if (code === 0) {
        log.info('ffmpeg', `#${runId} done in ${secs}s (exit 0)`)
        resolve(stderr)
      } else {
        const tail = stderr.split('\n').slice(-12).join('\n')
        log.error('ffmpeg', `#${runId} exited ${code} after ${secs}s — stderr tail:\n${tail}`)
        reject(new FFmpegError(`ffmpeg exited with code ${code}`, code, tail))
      }
    })
  })
}

/** Probe a media file for the stream facts the app needs. */
export async function probe(filePath: string): Promise<SourceInfo> {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    filePath
  ]
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(FFPROBE_BIN, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => reject(new Error(`ffprobe failed to start: ${e.message}`)))
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-500)}`))
    )
  })
  const json = JSON.parse(out)
  const video = (json.streams ?? []).find((s: any) => s.codec_type === 'video')
  const audio = (json.streams ?? []).find((s: any) => s.codec_type === 'audio')
  if (!video) {
    log.error('probe', `no video stream in ${filePath}`)
    throw new Error(`No video stream found in ${path.basename(filePath)}.`)
  }
  const fpsParts = String(video.r_frame_rate ?? '30/1').split('/')
  const fps = Number(fpsParts[0]) / Number(fpsParts[1] || 1)
  const info = {
    path: filePath,
    durationSec: Number(json.format?.duration ?? video.duration ?? 0),
    width: Number(video.width),
    height: Number(video.height),
    fps: Number.isFinite(fps) ? fps : 30,
    hasAudio: Boolean(audio)
  }
  log.info(
    'probe',
    `${filePath} → ${info.durationSec.toFixed(2)}s ${info.width}x${info.height} @${info.fps.toFixed(2)}fps ` +
      `v:${video.codec_name} a:${audio ? audio.codec_name : 'none'}`
  )
  return info
}

let nvencCache: boolean | null = null

/** Detect NVENC availability once per app run (RTX-class target machine). */
export async function hasNvenc(): Promise<boolean> {
  if (nvencCache !== null) return nvencCache
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(FFMPEG_BIN, ['-hide_banner', '-encoders'], { windowsHide: true })
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.on('error', reject)
      child.on('close', () => resolve(stdout))
    })
    nvencCache = out.includes('h264_nvenc')
  } catch {
    nvencCache = false
  }
  return nvencCache
}

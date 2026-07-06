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
import type { SourceInfo } from '@shared/types'

function resolveBin(mod: string, fallbackName: string): string {
  try {
    // ffmpeg-static exports the path directly; ffprobe-static exports { path }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require(mod)
    const p = typeof m === 'string' ? m : m?.path
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

/** Run ffmpeg with args; resolves on exit 0, rejects with stderr tail otherwise. */
export function runFFmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-y', ...args]
    if (opts.onProgress) fullArgs.push('-progress', 'pipe:1', '-nostats')

    const child = spawn(FFMPEG_BIN, fullArgs, { windowsHide: true })
    let stderr = ''
    let stdout = ''

    const onAbort = () => child.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 65536) stderr = stderr.slice(-32768)
    })
    child.stdout.on('data', (d) => {
      stdout += d.toString()
      if (opts.onProgress && opts.totalSec) {
        // -progress emits `out_time_us=NNN` lines
        const m = /out_time_us=(\d+)/g
        let last: RegExpExecArray | null = null
        let cur: RegExpExecArray | null
        while ((cur = m.exec(stdout)) !== null) last = cur
        if (last) {
          const sec = Number(last[1]) / 1_000_000
          opts.onProgress(Math.min(1, sec / opts.totalSec))
        }
        if (stdout.length > 65536) stdout = stdout.slice(-32768)
      }
    })
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new FFmpegError(`ffmpeg failed to start: ${err.message}`, null, ''))
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) {
        reject(new FFmpegError('Canceled', code, ''))
      } else if (code === 0) {
        resolve(stderr)
      } else {
        reject(
          new FFmpegError(
            `ffmpeg exited with code ${code}`,
            code,
            stderr.split('\n').slice(-12).join('\n')
          )
        )
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
  if (!video) throw new Error(`No video stream found in ${path.basename(filePath)}.`)
  const fpsParts = String(video.r_frame_rate ?? '30/1').split('/')
  const fps = Number(fpsParts[0]) / Number(fpsParts[1] || 1)
  return {
    path: filePath,
    durationSec: Number(json.format?.duration ?? video.duration ?? 0),
    width: Number(video.width),
    height: Number(video.height),
    fps: Number.isFinite(fps) ? fps : 30,
    hasAudio: Boolean(audio)
  }
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

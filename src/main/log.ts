/**
 * Session flight recorder. Everything notable since app start lands in one
 * in-memory ring buffer: explicit scoped logs from instrumented code (ffmpeg
 * commands, AI calls, pipeline decisions, queue jobs, IPC failures), all
 * console output from BOTH processes, and crash-level events. "Copy logs" in
 * the UI serializes the whole buffer for pasting into a bug report.
 *
 * NEVER log secret material: API keys live in safeStorage and must not pass
 * through here. Callers log key NAMES and byte lengths only.
 */
import { app } from 'electron'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  t: number
  level: LogLevel
  scope: string
  msg: string
}

const MAX_ENTRIES = 8000
const MAX_MSG_CHARS = 2000
const startedAt = Date.now()
const buffer: LogEntry[] = []
let dropped = 0

function push(level: LogLevel, scope: string, msg: string): void {
  buffer.push({ t: Date.now(), level, scope, msg: msg.length > MAX_MSG_CHARS ? msg.slice(0, MAX_MSG_CHARS) + '…[truncated]' : msg })
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES)
    dropped++
  }
}

/** Compact one-line JSON for structured context; resilient to cycles. */
export function fmt(data: unknown): string {
  try {
    const s = JSON.stringify(data)
    return s.length > 600 ? s.slice(0, 600) + '…' : s
  } catch {
    return String(data)
  }
}

export const log = {
  debug: (scope: string, msg: string) => push('debug', scope, msg),
  info: (scope: string, msg: string) => push('info', scope, msg),
  warn: (scope: string, msg: string) => push('warn', scope, msg),
  error: (scope: string, msg: string) => push('error', scope, msg)
}

/** Renderer-forwarded entries (window errors, console.warn/error, etc.). */
export function appendRendererLog(level: LogLevel, message: string): void {
  const lv: LogLevel = level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info'
  push(lv, 'renderer', String(message))
}

/**
 * Route main-process console.* into the buffer too — the codebase already
 * console.warn/error's in many places; this captures all of it without
 * touching every call site. Original console still prints.
 */
export function captureConsole(): void {
  const wrap = (level: LogLevel, orig: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      try {
        push(level, 'console', args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : fmt(a))).join(' '))
      } catch {
        /* logging must never break the app */
      }
      orig.apply(console, args)
    }
  console.log = wrap('info', console.log.bind(console))
  console.info = wrap('info', console.info.bind(console))
  console.warn = wrap('warn', console.warn.bind(console))
  console.error = wrap('error', console.error.bind(console))

  process.on('uncaughtException', (err) => {
    push('error', 'process', `uncaughtException: ${err?.message}\n${err?.stack ?? ''}`)
  })
  process.on('unhandledRejection', (reason: any) => {
    push('error', 'process', `unhandledRejection: ${reason?.message ?? String(reason)}\n${reason?.stack ?? ''}`)
  })
}

function ts(t: number): string {
  const d = new Date(t)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  const rel = ((t - startedAt) / 1000).toFixed(1).padStart(8)
  return `${hh}:${mm}:${ss}.${ms} +${rel}s`
}

/** Most recent formatted log lines, oldest→newest — feeds the in-app live
 *  logs panel. */
export function getLogTail(n = 200): string[] {
  return buffer.slice(-n).map((e) => `${ts(e.t)} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}`)
}

/** Full session log as pasteable text, newest last. Header carries the
 *  environment facts needed to reproduce (never secrets). */
export function getLogText(extraHeader: Record<string, unknown> = {}): string {
  const head = [
    '===== Zirtola session log =====',
    `generated : ${new Date().toISOString()}`,
    `app       : v${app.getVersion()} (packaged: ${app.isPackaged})`,
    `platform  : ${process.platform} ${process.arch} · electron ${process.versions.electron} · node ${process.versions.node}`,
    `started   : ${new Date(startedAt).toISOString()} (uptime ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min)`,
    ...Object.entries(extraHeader).map(([k, v]) => `${k.padEnd(10)}: ${fmt(v)}`),
    dropped > 0 ? `NOTE: ring buffer wrapped; oldest entries were dropped (${MAX_ENTRIES} kept)` : '',
    `entries   : ${buffer.length}`,
    '================================',
    ''
  ]
    .filter(Boolean)
    .join('\n')

  const lines = buffer.map((e) => `${ts(e.t)} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}`)
  return head + lines.join('\n') + '\n'
}

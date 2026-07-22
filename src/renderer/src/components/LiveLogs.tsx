/**
 * Live logs strip — a streaming tail of the session flight recorder, so
 * what the app is doing (ffmpeg runs, AI calls, pipeline decisions) is
 * visible in real time. Auto-scrolls to the newest line unless the user has
 * scrolled up to read; "Copy logs" in the header grabs the full session.
 */
import { useEffect, useRef, useState } from 'react'

const POLL_MS = 1500
const TAIL_LINES = 250

function levelColor(line: string): string {
  if (line.includes(' ERROR ')) return 'text-cut'
  if (line.includes(' WARN ')) return 'text-warn'
  return 'text-ink-400'
}

export default function LiveLogs() {
  const [lines, setLines] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const tail = await window.zirtola.getLogTail(TAIL_LINES)
        if (alive) setLines(tail)
      } catch {
        /* main not ready — retry next tick */
      }
    }
    poll()
    const t = window.setInterval(poll, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  // Stick to the bottom unless the user scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="panel h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-ink-700 text-[11px] text-ink-400 shrink-0">
        <span className="font-display font-semibold text-ink-300">Live logs</span>
        <span className="text-ink-600">· session activity (ffmpeg · AI · pipeline)</span>
        <div className="flex-1" />
        <span className="text-ink-600">scroll up to pause · ⧉ Copy logs for the full session</span>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-1 font-mono text-[10px] leading-[1.5]"
        onScroll={(e) => {
          const el = e.currentTarget
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {lines.length === 0 ? (
          <p className="text-ink-600 py-1">Waiting for activity…</p>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all ${levelColor(l)}`}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

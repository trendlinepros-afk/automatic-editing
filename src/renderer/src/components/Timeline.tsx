/**
 * Timeline — the review surface, drawn entirely in SOURCE time (the domain
 * every EDL event is stored in). The preview video plays the TRIMMED
 * timeline, so exactly two conversions happen here:
 *   - click-to-seek: source → trimmed before seeking the video
 *   - playhead: trimmed (video clock) → source for display
 *
 * Tracks: cuts, transitions+graphics (FX), music. Click to seek; drag on the
 * ruler to select a region for a revision instruction; drag cut edges to
 * adjust in/out points manually (one undoable EDL edit per drag).
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useStore, formatTime } from '../state/store'
import { cutsToKeepSegments, sourceToTrimmedTime, trimmedToSourceTime } from '@shared/timemap'
import type { CutRegion } from '@shared/types'

type Drag =
  | { kind: 'select'; from: number; to: number }
  // t0 = the edge's original value, for the no-movement click guard.
  | { kind: 'cut-edge'; id: string; edge: 'start' | 'end'; t: number; t0: number }
  | null

/** Ignore edge "drags" that moved less than this — a plain click on the 6px
 *  handle must not commit a pixel-quantized boundary shift (which would also
 *  mark the whole pipeline stale). */
const EDGE_COMMIT_THRESHOLD_SEC = 0.03

export default function Timeline() {
  const { project, currentTime, seek, selection, setSelection, mutateEdl } = useStore()
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const dragRef = useRef<Drag>(null)
  dragRef.current = drag

  const keep = useMemo(
    () =>
      project
        ? (project.trimKeep ?? cutsToKeepSegments(project.edl.cuts, project.source.durationSec))
        : [],
    [project?.trimKeep, project?.edl.version, project?.source.durationSec]
  )

  // NOTE: the null-project guard is deferred until AFTER every hook below
  // (the window-listener useEffect) so hooks run unconditionally. These
  // non-hook consts are null-safe; the JSX (which uses project) is gated.
  const duration = project ? project.source.durationSec || 1 : 1

  const pxToTime = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect()
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration))
  }
  const pct = (t: number) => `${(t / duration) * 100}%`
  const widthPct = (a: number, b: number) => `${(Math.max(0, b - a) / duration) * 100}%`

  function onRulerDown(e: MouseEvent) {
    const from = pxToTime(e.clientX)
    setDrag({ kind: 'select', from, to: from })
  }

  // Gestures track on the WINDOW while active, so leaving the panel (fast
  // drags, edges of the track) never silently drops a nearly-finished
  // adjustment — mouseup anywhere commits.
  useEffect(() => {
    if (!drag) return
    const onMove = (e: globalThis.MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const t = pxToTime(e.clientX)
      setDrag(d.kind === 'select' ? { ...d, to: t } : { ...d, t })
    }
    const onUp = (e: globalThis.MouseEvent) => {
      const d = dragRef.current
      setDrag(null)
      if (!d) return
      const t = pxToTime(e.clientX)
      if (d.kind === 'select') {
        const a = Math.min(d.from, t)
        const b = Math.max(d.from, t)
        if (b - a < 0.15) {
          // Plain click: seek the preview (convert source → trimmed).
          seek(sourceToTrimmedTime(a, keep))
          setSelection({ region: null })
        } else {
          setSelection({ region: { start: a, end: b } })
        }
      } else {
        // A click that didn't actually move the edge is not an edit.
        if (Math.abs(t - d.t0) < EDGE_COMMIT_THRESHOLD_SEC) return
        const { id, edge } = d
        // Commit the edge drag as ONE undoable EDL mutation.
        mutateEdl((edl) => ({
          ...edl,
          cuts: edl.cuts.map((c) => (c.id === id ? clampCut({ ...c, [edge]: t, origin: 'manual' as const }) : c))
        }))
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // Re-arm only when a gesture starts/ends, not on every position update.
  }, [drag !== null, keep])

  if (!project) return null

  const cuts = project.edl.cuts.filter((c) => c.status !== 'rejected')
  const sel =
    drag?.kind === 'select'
      ? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) }
      : selection.region

  // Playhead: the video reports trimmed time; display it in source time.
  const playheadSrc = trimmedToSourceTime(currentTime, keep)

  return (
    <div className="panel p-3 select-none">
      <div className="flex items-center justify-between mb-2 text-xs text-ink-400">
        <span className="font-display font-semibold text-ink-200">Timeline</span>
        <span>
          {sel
            ? `Selected ${formatTime(sel.start)} – ${formatTime(sel.end)}`
            : 'Drag on the ruler to select a region · click to seek · drag cut edges to adjust'}
        </span>
        <span className="font-mono">{formatTime(duration)}</span>
      </div>

      <div ref={trackRef} className="relative cursor-crosshair" onMouseDown={onRulerDown}>
        {/* Ruler */}
        <div className="h-6 bg-ink-850 rounded-t-md relative border border-ink-700 border-b-0">
          {[...Array(11)].map((_, i) => (
            <span
              key={i}
              className="absolute top-1 text-[9px] text-ink-500 font-mono -translate-x-1/2"
              style={{ left: `${i * 10}%` }}
            >
              {formatTime((duration * i) / 10)}
            </span>
          ))}
        </div>

        {/* Cut track */}
        <Track label="Cuts">
          {cuts.map((c) => {
            const isDragged = drag?.kind === 'cut-edge' && drag.id === c.id
            const start = isDragged && drag.edge === 'start' ? drag.t : c.start
            const end = isDragged && drag.edge === 'end' ? drag.t : c.end
            return (
              <div
                key={c.id}
                title={`${c.status} cut ${formatTime(start)}–${formatTime(end)}${c.note ? ` — ${c.note}` : ''}`}
                className={`absolute top-0.5 bottom-0.5 rounded-sm ${
                  c.status === 'proposed' ? 'bg-cut/30 border border-cut/50' : 'bg-cut/60'
                }`}
                style={{ left: pct(Math.min(start, end)), width: widthPct(Math.min(start, end), Math.max(start, end)) }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <Edge onDown={() => setDrag({ kind: 'cut-edge', id: c.id, edge: 'start', t: c.start, t0: c.start })} side="left" />
                <Edge onDown={() => setDrag({ kind: 'cut-edge', id: c.id, edge: 'end', t: c.end, t0: c.end })} side="right" />
              </div>
            )
          })}
        </Track>

        {/* Transitions + graphics — source-anchored, same scale as the ruler */}
        <Track label="FX">
          {project.edl.transitions.map((t) => (
            <div
              key={t.id}
              title={`${t.kind} @ ${formatTime(t.at)}`}
              className="absolute top-1 bottom-1 w-1 bg-warn rounded-full"
              style={{ left: pct(t.at) }}
            />
          ))}
          {project.edl.graphics
            .filter((g) => g.status !== 'rejected')
            .map((g) => (
              <div
                key={g.id}
                title={`${g.templateId} (${g.status}) @ ${formatTime(g.at)}`}
                className={`absolute top-1 bottom-1 rounded-sm ${g.status === 'rendered' ? 'bg-graphic/70' : 'bg-graphic/30 border border-graphic/60'}`}
                style={{ left: pct(g.at), width: widthPct(g.at, g.at + g.durationSec) }}
              />
            ))}
        </Track>

        <Track label="Music" last>
          {project.edl.music.map((m) => (
            <div
              key={m.id}
              title={`${m.filePath.split(/[\\/]/).pop()} (${m.gainDb}dB, duck ${m.duckDb}dB)`}
              className="absolute top-1 bottom-1 bg-music/50 rounded-sm"
              style={{ left: pct(m.region.start), width: widthPct(m.region.start, m.region.end) }}
            />
          ))}
        </Track>

        {/* Selection overlay */}
        {sel && (
          <div
            className="absolute top-0 bottom-0 bg-signal/10 border-x-2 border-signal/70 pointer-events-none"
            style={{ left: pct(sel.start), width: widthPct(sel.start, sel.end) }}
          />
        )}

        {/* Playhead */}
        <div
          className="absolute -top-1 bottom-0 w-0.5 bg-signal pointer-events-none shadow-[0_0_8px_rgba(94,234,212,0.7)]"
          style={{ left: pct(Math.min(playheadSrc, duration)) }}
        >
          <div className="w-2.5 h-2.5 bg-signal rotate-45 -translate-x-1 -translate-y-0.5" />
        </div>
      </div>
    </div>
  )
}

function Track({ label, children, last = false }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`relative h-9 bg-ink-900 border border-ink-700 border-b-0 ${last ? 'rounded-b-md !border-b' : ''}`}>
      <span className="absolute left-1.5 top-1 text-[9px] uppercase tracking-wider text-ink-600 pointer-events-none z-10">
        {label}
      </span>
      {children}
    </div>
  )
}

function Edge({ onDown, side }: { onDown: () => void; side: 'left' | 'right' }) {
  return (
    <div
      className={`absolute top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-ink-50/40 ${side === 'left' ? 'left-0' : 'right-0'}`}
      onMouseDown={(e) => {
        e.stopPropagation()
        onDown()
      }}
    />
  )
}

function clampCut(c: CutRegion): CutRegion {
  if (c.end < c.start) return { ...c, start: c.end, end: c.start }
  return c
}

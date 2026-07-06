/**
 * Timeline — the review surface. Tracks: cuts (source timeline), transitions,
 * graphics, music (trimmed timeline). Click to seek; drag on the ruler to
 * select a region for a revision instruction; drag cut edges to adjust
 * in/out points manually (writes to the EDL like any other edit).
 */
import { useRef, useState, type MouseEvent } from 'react'
import { useStore, formatTime } from '../state/store'
import type { CutRegion } from '@shared/types'

export default function Timeline() {
  const { project, currentTime, seek, selection, setSelection, mutateEdl } = useStore()
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragSel, setDragSel] = useState<{ from: number; to: number } | null>(null)
  const [dragCut, setDragCut] = useState<{ id: string; edge: 'start' | 'end' } | null>(null)

  if (!project) return null
  const duration = project.source.durationSec || 1

  const pxToTime = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect()
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration))
  }
  const pct = (t: number) => `${(t / duration) * 100}%`
  const widthPct = (a: number, b: number) => `${((b - a) / duration) * 100}%`

  function onRulerDown(e: MouseEvent) {
    const from = pxToTime(e.clientX)
    setDragSel({ from, to: from })
  }
  function onMove(e: MouseEvent) {
    if (dragSel) setDragSel({ ...dragSel, to: pxToTime(e.clientX) })
    if (dragCut) {
      const t = pxToTime(e.clientX)
      mutateNoHistory(dragCut, t)
    }
  }
  function onUp(e: MouseEvent) {
    if (dragSel) {
      const a = Math.min(dragSel.from, dragSel.to)
      const b = Math.max(dragSel.from, dragSel.to)
      if (b - a < 0.15) {
        seek(a)
        setSelection({ region: null })
      } else {
        setSelection({ region: { start: a, end: b } })
      }
      setDragSel(null)
    }
    if (dragCut) {
      const t = pxToTime(e.clientX)
      const { id, edge } = dragCut
      setDragCut(null)
      // Commit the drag as one undoable EDL mutation.
      mutateEdl((edl) => ({
        ...edl,
        cuts: edl.cuts.map((c) => (c.id === id ? clampCut({ ...c, [edge]: t, origin: 'manual' as const }) : c))
      }))
    }
  }

  // During drag we don't spam undo history — visual feedback only via local state.
  const [liveCut, setLiveCut] = useState<{ id: string; start?: number; end?: number } | null>(null)
  function mutateNoHistory(drag: { id: string; edge: 'start' | 'end' }, t: number) {
    setLiveCut({ id: drag.id, [drag.edge]: t })
  }

  const cuts = project.edl.cuts.filter((c) => c.status !== 'rejected')
  const sel = dragSel
    ? { start: Math.min(dragSel.from, dragSel.to), end: Math.max(dragSel.from, dragSel.to) }
    : selection.region

  return (
    <div className="panel p-3 select-none" onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => setDragSel(null)}>
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

        {/* Cut track (source timeline) */}
        <Track label="Cuts">
          {cuts.map((c) => {
            const start = liveCut?.id === c.id && liveCut.start !== undefined ? liveCut.start : c.start
            const end = liveCut?.id === c.id && liveCut.end !== undefined ? liveCut.end : c.end
            return (
              <div
                key={c.id}
                title={`${c.status} cut ${formatTime(start)}–${formatTime(end)}${c.note ? ` — ${c.note}` : ''}`}
                className={`absolute top-0.5 bottom-0.5 rounded-sm ${
                  c.status === 'proposed' ? 'bg-cut/30 border border-cut/50' : 'bg-cut/60'
                }`}
                style={{ left: pct(start), width: widthPct(start, end) }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <Edge onDown={() => setDragCut({ id: c.id, edge: 'start' })} side="left" />
                <Edge onDown={() => setDragCut({ id: c.id, edge: 'end' })} side="right" />
              </div>
            )
          })}
        </Track>

        {/* Transitions + graphics + music (trimmed-timeline events, shown on the
            same scale for review; exact alignment appears in the preview) */}
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
          style={{ left: pct(Math.min(currentTime, duration)) }}
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

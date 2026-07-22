/**
 * Transcript — time-linked to the timeline. Word/segment times are SOURCE
 * time; the preview video plays TRIMMED time, so seeking converts source →
 * trimmed and the active-word highlight converts the video clock back to
 * source. Segments are memoized: during playback only the segment under the
 * playhead re-renders, not the whole (possibly hour-long) transcript.
 */
import { memo, useCallback, useMemo, useState } from 'react'
import { useStore, formatTime } from '../state/store'
import { cutsToKeepSegments, sourceToTrimmedTime, trimmedToSourceTime } from '@shared/timemap'
import { newId } from '@shared/id'
import type { TimeRegion, TranscriptSegment } from '@shared/types'

export default function Transcript() {
  const project = useStore((s) => s.project)
  const currentTime = useStore((s) => s.currentTime)
  const selection = useStore((s) => s.selection)
  const [deleting, setDeleting] = useState(false)

  /** Manually cut the checked lines out of the video: adds word-precise
   *  manual cuts (trusted — no AI re-review) and re-renders stages 2–6. */
  async function deleteSelected() {
    const s = useStore.getState()
    const proj = s.project
    if (!proj?.transcript || s.selection.segmentIds.length === 0) return
    const ids = new Set(s.selection.segmentIds)
    const segs = proj.transcript.segments.filter((x) => ids.has(x.id))
    if (segs.length === 0) return
    if (
      !confirm(
        `Delete ${segs.length} line(s) from the video? The lines stay visible (struck through) in the transcript, and the edit re-renders now.`
      )
    ) {
      return
    }
    setDeleting(true)
    try {
      await s.mutateEdl((edl) => {
        for (const seg of segs) {
          edl.cuts.push({
            id: newId('cut'),
            start: Math.max(0, (seg.words[0]?.start ?? seg.start) - 0.05),
            end: (seg.words[seg.words.length - 1]?.end ?? seg.end) + 0.05,
            padMs: 0,
            origin: 'manual',
            status: 'validated',
            kind: 'retake',
            note: 'Deleted from transcript'
          })
        }
        return edl
      })
      s.clearSelection()
      // Re-apply cuts and everything downstream (no graphics re-plan).
      window.zirtola.runStage(proj.id, 'cut-review')
    } finally {
      setDeleting(false)
    }
  }

  const keep = useMemo(
    () =>
      project
        ? (project.trimKeep ?? cutsToKeepSegments(project.edl.cuts, project.source?.durationSec ?? 0))
        : [],
    [project?.trimKeep, project?.edl.version, project?.source?.durationSec]
  )

  // Non-rejected cut regions, sorted — used to strike words that will be removed.
  const cutRegions = useMemo(
    () =>
      (project?.edl.cuts ?? [])
        .filter((c) => c.status !== 'rejected')
        .map((c) => ({ start: c.start, end: c.end }))
        .sort((a, b) => a.start - b.start),
    [project?.edl.version]
  )

  // Referentially STABLE callbacks (they read fresh state via getState) —
  // otherwise every SegmentRow's memo() is defeated by new function
  // identities on each ~4Hz timeupdate render.
  const toggleSegment = useCallback((id: string) => {
    const s = useStore.getState()
    const cur = s.selection.segmentIds
    s.setSelection({ segmentIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  }, [])

  const seekSource = useCallback(
    (t: number) => useStore.getState().seek(sourceToTrimmedTime(t, keep)),
    [keep]
  )

  if (!project) return null
  if (!project.transcript) {
    return (
      <div className="panel flex-1 min-h-0 p-4 text-sm text-ink-500">
        No transcript yet. Run the pipeline — stage 1 transcribes the audio first (cost estimate shown before it runs).
      </div>
    )
  }

  // Video clock (trimmed) → source time, once per render.
  const srcTime = trimmedToSourceTime(currentTime, keep)

  return (
    <div className="panel flex-1 min-h-0 overflow-y-auto p-3 leading-relaxed select-text">
      <div className="flex items-center justify-between gap-2 mb-2 text-xs text-ink-400 sticky top-0 bg-ink-900 pb-1">
        <span className="font-display font-semibold text-ink-200">Transcript</span>
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">
            {selection.segmentIds.length > 0
              ? `${selection.segmentIds.length} line(s) selected`
              : 'Click a word to seek · check lines to delete or target a revision'}
            {project.transcript.source === 'mock' && <span className="ml-2 text-warn">mock transcript (no OpenAI key)</span>}
          </span>
          {selection.segmentIds.length > 0 && (
            <button
              className="btn btn-danger text-xs shrink-0 !py-0.5"
              disabled={deleting}
              onClick={deleteSelected}
              title="Cut the selected lines out of the video (undoable with Ctrl+Z)"
            >
              {deleting ? 'Deleting…' : `🗑 Delete ${selection.segmentIds.length} line(s)`}
            </button>
          )}
        </span>
      </div>

      {project.transcript.segments.map((seg) => {
        const active = srcTime >= seg.start && srcTime < seg.end
        return (
          <SegmentRow
            key={seg.id}
            seg={seg}
            // Only the active segment receives the live clock — every other
            // row's props are stable, so memo() skips them during playback.
            srcTime={active ? srcTime : -1}
            active={active}
            selected={selection.segmentIds.includes(seg.id)}
            cutRegions={cutRegions}
            onToggle={toggleSegment}
            onSeek={seekSource}
          />
        )
      })}
    </div>
  )
}

interface RowProps {
  seg: TranscriptSegment
  srcTime: number
  active: boolean
  selected: boolean
  cutRegions: TimeRegion[]
  onToggle: (id: string) => void
  onSeek: (t: number) => void
}

const SegmentRow = memo(function SegmentRow({ seg, srcTime, active, selected, cutRegions, onToggle, onSeek }: RowProps) {
  const isCutTime = (t: number) => {
    for (const c of cutRegions) {
      if (t < c.start) return false // sorted — no later region can match
      if (t < c.end) return true
    }
    return false
  }

  return (
    <div className={`group flex gap-2 rounded px-1.5 py-0.5 ${selected ? 'seg-selected' : ''} ${active ? 'bg-ink-850' : ''}`}>
      <label className="shrink-0 flex items-start pt-1 gap-1.5 w-20 cursor-pointer">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(seg.id)}
          className="accent-[#5eead4]"
          aria-label={`Select segment at ${formatTime(seg.start)}`}
        />
        <span className="text-[10px] font-mono text-ink-500 group-hover:text-signal">{formatTime(seg.start)}</span>
      </label>
      <p className="text-sm text-ink-200">
        {seg.words.length > 0 ? (
          seg.words.map((w, i) => {
            const wActive = srcTime >= w.start && srcTime < w.end
            const wCut = isCutTime((w.start + w.end) / 2)
            return (
              <span
                key={i}
                className={`word ${wActive ? 'word-active' : ''} ${wCut ? 'word-cut' : ''}`}
                onClick={() => onSeek(w.start)}
                title={wCut ? 'Inside a cut region — will be removed' : formatTime(w.start)}
              >
                {w.word.trim()}{' '}
              </span>
            )
          })
        ) : (
          <span className="word" onClick={() => onSeek(seg.start)}>
            {seg.text}
          </span>
        )}
      </p>
    </div>
  )
})

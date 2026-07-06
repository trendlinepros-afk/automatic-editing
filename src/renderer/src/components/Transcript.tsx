/**
 * Transcript — time-linked to the timeline. Click a word to seek; click a
 * segment's checkbox (or shift-click segments) to select a span for a
 * revision instruction. Words inside cut regions render struck-through.
 */
import { useStore, formatTime } from '../state/store'

export default function Transcript() {
  const { project, currentTime, seek, selection, setSelection } = useStore()
  if (!project) return null

  if (!project.transcript) {
    return (
      <div className="panel flex-1 min-h-0 p-4 text-sm text-ink-500">
        No transcript yet. Run the pipeline — stage 1 transcribes the audio first (cost estimate shown before it runs).
      </div>
    )
  }

  const cuts = project.edl.cuts.filter((c) => c.status !== 'rejected')
  const isCutTime = (t: number) => cuts.some((c) => t >= c.start && t < c.end)

  function toggleSegment(id: string) {
    const cur = selection.segmentIds
    setSelection({ segmentIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  }

  return (
    <div className="panel flex-1 min-h-0 overflow-y-auto p-3 leading-relaxed">
      <div className="flex items-center justify-between mb-2 text-xs text-ink-400 sticky top-0 bg-ink-900 pb-1">
        <span className="font-display font-semibold text-ink-200">Transcript</span>
        <span>
          {selection.segmentIds.length > 0
            ? `${selection.segmentIds.length} segment(s) selected for revision`
            : 'Click a word to seek · check segments to target a revision'}
          {project.transcript.source === 'mock' && <span className="ml-2 text-warn">mock transcript (no OpenAI key)</span>}
        </span>
      </div>

      {project.transcript.segments.map((seg) => {
        const active = currentTime >= seg.start && currentTime < seg.end
        const selected = selection.segmentIds.includes(seg.id)
        return (
          <div
            key={seg.id}
            className={`group flex gap-2 rounded px-1.5 py-0.5 ${selected ? 'seg-selected' : ''} ${active ? 'bg-ink-850' : ''}`}
          >
            <label className="shrink-0 flex items-start pt-1 gap-1.5 w-20 cursor-pointer">
              <input
                type="checkbox"
                checked={selected}
                onChange={() => toggleSegment(seg.id)}
                className="accent-[#5eead4]"
                aria-label={`Select segment at ${formatTime(seg.start)}`}
              />
              <span className="text-[10px] font-mono text-ink-500 group-hover:text-signal">{formatTime(seg.start)}</span>
            </label>
            <p className="text-sm text-ink-200">
              {seg.words.length > 0
                ? seg.words.map((w, i) => {
                    const wActive = currentTime >= w.start && currentTime < w.end
                    const wCut = isCutTime((w.start + w.end) / 2)
                    return (
                      <span
                        key={i}
                        className={`word ${wActive ? 'word-active' : ''} ${wCut ? 'word-cut' : ''}`}
                        onClick={() => seek(w.start)}
                        title={wCut ? 'Inside a cut region — will be removed' : formatTime(w.start)}
                      >
                        {w.word.trim()}{' '}
                      </span>
                    )
                  })
                : (
                  <span className="word" onClick={() => seek(seg.start)}>
                    {seg.text}
                  </span>
                )}
            </p>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Revision bar — natural-language instructions scoped to the current timeline
 * region / transcript selection. Routed to the AI layer, mapped to one
 * pipeline stage, and only that stage re-runs.
 */
import { useState } from 'react'
import { useStore, formatTime } from '../state/store'

export default function RevisionBar() {
  const { project, selection, clearSelection } = useStore()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastResult, setLastResult] = useState<string | null>(null)

  if (!project) return null
  const hasScope = selection.region || selection.segmentIds.length > 0

  async function submit() {
    if (!project || !text.trim()) return
    setBusy(true)
    setLastResult(null)
    try {
      const rev = await window.zirtola.submitRevision(
        project.id,
        text.trim(),
        selection.region ?? undefined,
        selection.segmentIds.length ? selection.segmentIds : undefined
      )
      if (rev.status === 'failed') {
        setLastResult(`Couldn't apply: ${rev.error}`)
      } else {
        setLastResult(`Applied via stage "${rev.mappedStage}" — preview is re-rendering.`)
        setText('')
        clearSelection()
      }
    } catch (err: any) {
      setLastResult(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-3">
      <div className="panel flex items-center gap-2 p-2">
        <span className="text-xs text-ink-500 shrink-0 w-44 truncate">
          {selection.region
            ? `Region ${formatTime(selection.region.start)}–${formatTime(selection.region.end)}`
            : selection.segmentIds.length > 0
              ? `${selection.segmentIds.length} transcript segment(s)`
              : 'Whole video'}
          {hasScope && (
            <button className="ml-1 text-signal hover:underline" onClick={clearSelection}>
              clear
            </button>
          )}
        </span>
        <input
          className="input flex-1"
          placeholder={`Describe a revision — "tighten this cut", "music too loud here", "add a lower-third with his name"…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={busy}
        />
        <button className="btn btn-primary shrink-0" onClick={submit} disabled={busy || !text.trim()}>
          {busy ? 'Applying…' : 'Revise'}
        </button>
      </div>
      {lastResult && <p className="text-xs text-ink-400 mt-1 px-1">{lastResult}</p>}
    </div>
  )
}

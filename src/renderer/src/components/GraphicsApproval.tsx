/**
 * Stage 4 approval gate — the AI's graphic plan is presented BEFORE any
 * HyperFrames rendering. The user can edit slot text, toggle each graphic,
 * then approve; only approved graphics render (protects render time and
 * API budget).
 */
import { useState } from 'react'
import { useStore, formatTime } from '../state/store'
import type { GraphicEvent } from '@shared/types'

export default function GraphicsApproval() {
  const project = useStore((s) => s.project)
  const planned = project?.edl.graphics.filter((g) => g.status === 'planned') ?? []
  const [drafts, setDrafts] = useState<GraphicEvent[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [approvedIds, setApprovedIds] = useState<string[]>(() => planned.map((g) => g.id))
  if (!project) return null

  const items = drafts ?? planned

  function updateSlot(id: string, slot: string, value: string) {
    setDrafts((cur) => (cur ?? planned).map((g) => (g.id === id ? { ...g, slots: { ...g.slots, [slot]: value } } : g)))
  }

  async function approve() {
    setSubmitting(true)
    await window.wickedcut.approveGraphics(project!.id, approvedIds, items)
  }

  return (
    <div className="fixed inset-0 bg-ink-950/80 flex items-center justify-center z-50 p-8">
      <div className="panel max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="p-4 border-b border-ink-700">
          <h2 className="font-display font-bold text-ink-50">Graphics plan — approve before rendering</h2>
          <p className="text-xs text-ink-400 mt-1">
            Nothing renders until you approve. Uncheck what you don't want; edit any text. HyperFrames renders only the
            approved list.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {items.length === 0 && <p className="text-sm text-ink-500">The AI planned no graphics for this video.</p>}
          {items.map((g) => (
            <div key={g.id} className={`panel bg-ink-850 p-3 ${approvedIds.includes(g.id) ? '' : 'opacity-50'}`}>
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  checked={approvedIds.includes(g.id)}
                  onChange={(e) =>
                    setApprovedIds((cur) => (e.target.checked ? [...cur, g.id] : cur.filter((x) => x !== g.id)))
                  }
                  className="accent-[#5eead4]"
                />
                <span className="text-sm font-medium text-graphic">{g.templateId}</span>
                <span className="text-xs font-mono text-ink-500">
                  @ {formatTime(g.at)} · {g.durationSec}s
                </span>
              </div>
              {g.rationale && <p className="text-xs text-ink-500 mb-2 ml-6">{g.rationale}</p>}
              <div className="ml-6 grid gap-1.5">
                {Object.entries(g.slots).map(([slot, value]) => (
                  <label key={slot} className="flex items-center gap-2 text-xs">
                    <span className="w-24 text-ink-500 shrink-0">{slot}</span>
                    <input className="input !py-1" value={value} onChange={(e) => updateSlot(g.id, slot, e.target.value)} />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-ink-700 flex justify-end gap-2">
          <button
            className="btn"
            disabled={submitting}
            onClick={() => window.wickedcut.approveGraphics(project.id, [], items)}
          >
            Skip all graphics
          </button>
          <button className="btn btn-primary" disabled={submitting} onClick={approve}>
            {submitting ? 'Rendering…' : `Approve ${approvedIds.length} & render`}
          </button>
        </div>
      </div>
    </div>
  )
}

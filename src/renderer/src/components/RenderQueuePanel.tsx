/** Render queue side panel — every long operation, with cancel. */
import { useState } from 'react'
import { useStore } from '../state/store'

export default function RenderQueuePanel() {
  const jobs = useStore((s) => s.jobs)
  const [open, setOpen] = useState(true)
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')

  return (
    <aside className={`shrink-0 border-l border-ink-700 bg-ink-900 flex flex-col transition-all ${open ? 'w-64' : 'w-9'}`}>
      <button
        className="h-9 flex items-center gap-2 px-2.5 text-xs text-ink-400 hover:text-signal border-b border-ink-700"
        onClick={() => setOpen(!open)}
        title="Render queue"
      >
        <span className={active.length > 0 ? 'text-signal animate-pulse' : ''}>●</span>
        {open && <span>Queue {active.length > 0 && `(${active.length} active)`}</span>}
      </button>
      {open && (
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {jobs.length === 0 && <p className="text-xs text-ink-600 p-2">Nothing queued. Long operations appear here with progress and a cancel button.</p>}
          {jobs.slice(0, 30).map((j) => (
            <div key={j.id} className="panel bg-ink-850 p-2">
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] uppercase tracking-wide ${statusColor(j.status)}`}>{j.status}</span>
                <span className="flex-1" />
                {(j.status === 'running' || j.status === 'queued') && (
                  <button className="text-[10px] text-cut hover:underline" onClick={() => window.wickedcut.cancelJob(j.id)}>
                    cancel
                  </button>
                )}
              </div>
              <p className="text-xs text-ink-200 mt-0.5 leading-snug">{j.label}</p>
              {j.detail && <p className="text-[10px] text-ink-500 mt-0.5">{j.detail}</p>}
              {j.status === 'running' && (
                <div className="h-1 bg-ink-700 rounded-full mt-1.5 overflow-hidden">
                  <div
                    className={`h-full bg-signal transition-all ${j.progress < 0 ? 'w-1/3 animate-pulse' : ''}`}
                    style={j.progress >= 0 ? { width: `${j.progress * 100}%` } : undefined}
                  />
                </div>
              )}
              {j.error && <p className="text-[10px] text-cut mt-1">{j.error}</p>}
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'text-signal'
    case 'done':
      return 'text-ink-500'
    case 'error':
      return 'text-cut'
    case 'canceled':
      return 'text-warn'
    default:
      return 'text-ink-400'
  }
}

/** Render queue side panel — every long operation, with cancel. */
import { useState } from 'react'
import { useStore } from '../state/store'
import { STAGE_ORDER } from '@shared/types'

export default function RenderQueuePanel() {
  const jobs = useStore((s) => s.jobs)
  const project = useStore((s) => s.project)
  const [open, setOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')

  // Everything currently in an error state — failed jobs and any stage marked
  // 'error' on the open project — collected into one copyable report.
  const jobErrors = jobs.filter((j) => j.status === 'error' && j.error)
  const stageErrors = project ? STAGE_ORDER.filter((id) => project.stages[id].status === 'error' && project.stages[id].error) : []
  const errorCount = jobErrors.length + stageErrors.length

  async function copyErrors() {
    const lines: string[] = [`Zirtola errors — ${new Date().toISOString()}`]
    if (project) lines.push(`Project: ${project.name}`)
    for (const id of stageErrors) {
      lines.push('', `STAGE [${id}]: ${project!.stages[id].error}`)
    }
    for (const j of jobErrors) {
      lines.push('', `JOB: ${j.label}${j.detail ? ` (${j.detail})` : ''}`, j.error!)
    }
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

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
      {open && errorCount > 0 && (
        <button
          className="mx-2 mt-2 btn btn-danger text-xs"
          onClick={copyErrors}
          title="Copy all current errors to the clipboard"
        >
          {copied ? '✓ Copied' : `Copy ${errorCount} error${errorCount > 1 ? 's' : ''}`}
        </button>
      )}
      {open && (
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {jobs.length === 0 && <p className="text-xs text-ink-600 p-2">Nothing queued. Long operations appear here with progress and a cancel button.</p>}
          {jobs.slice(0, 30).map((j) => (
            <div key={j.id} className="panel bg-ink-850 p-2">
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] uppercase tracking-wide ${statusColor(j.status)}`}>{j.status}</span>
                <span className="flex-1" />
                {(j.status === 'running' || j.status === 'queued') && (
                  <button className="text-[10px] text-cut hover:underline" onClick={() => window.zirtola.cancelJob(j.id)}>
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

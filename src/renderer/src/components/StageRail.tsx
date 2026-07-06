import { useState } from 'react'
import { useStore } from '../state/store'
import { STAGE_ORDER, type StageId } from '@shared/types'

const STAGE_META: Record<StageId, { n: number; label: string; desc: string }> = {
  'cut-detect': { n: 1, label: 'Cut dead space', desc: 'Silence detection → proposed cuts' },
  'cut-review': { n: 2, label: 'Review cuts', desc: 'AI validates against transcript, then applies' },
  transitions: { n: 3, label: 'Transitions', desc: 'Major scene changes only' },
  graphics: { n: 4, label: 'Graphics', desc: 'AI plan → your approval → HyperFrames' },
  audio: { n: 5, label: 'Sound & music', desc: 'SFX + music with auto-ducking' },
  preview: { n: 6, label: 'Preview', desc: 'Low-res render for review' }
}

export default function StageRail() {
  const project = useStore((s) => s.project)
  const [estimate, setEstimate] = useState<{ minutes: number; estUsd: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  if (!project) return null

  const anyRunning = STAGE_ORDER.some((id) => project.stages[id].status === 'running')

  async function startPipeline() {
    if (!project) return
    if (!project.transcript) {
      const est = await window.wickedcut.estimateTranscription(project.id)
      setEstimate(est)
      setConfirming(true)
      return
    }
    window.wickedcut.runPipeline(project.id)
  }

  return (
    <aside className="w-72 shrink-0 panel p-3 flex flex-col gap-2 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="font-display font-semibold text-ink-50 text-sm">Pipeline</h2>
        <button className="btn btn-primary text-xs" onClick={startPipeline} disabled={anyRunning}>
          {anyRunning ? 'Running…' : 'Run pipeline'}
        </button>
      </div>

      {confirming && estimate && (
        <div className="panel bg-ink-850 p-3 text-xs space-y-2">
          <p className="text-ink-200">
            Transcription (OpenAI Whisper) will process <b>{estimate.minutes} min</b> of audio — estimated{' '}
            <b className="text-signal">${estimate.estUsd.toFixed(3)}</b>.
          </p>
          <div className="flex gap-2">
            <button
              className="btn btn-primary text-xs"
              onClick={() => {
                setConfirming(false)
                window.wickedcut.runPipeline(project.id)
              }}
            >
              Run
            </button>
            <button className="btn text-xs" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {STAGE_ORDER.map((id) => {
        const st = project.stages[id]
        const meta = STAGE_META[id]
        return (
          <div key={id} className={`rounded-md border p-2 ${borderCls(st.status)}`}>
            <div className="flex items-center gap-2">
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${badgeCls(st.status)}`}>
                {st.status === 'done' ? '✓' : meta.n}
              </span>
              <span className="text-sm text-ink-200 flex-1">{meta.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-ink-500">{st.status}</span>
              {(st.status === 'done' || st.status === 'stale' || st.status === 'error') && (
                <button
                  className="text-[10px] text-signal hover:underline"
                  onClick={() => window.wickedcut.runStage(project.id, id)}
                  title="Re-run this stage only"
                >
                  re-run
                </button>
              )}
            </div>
            <p className="text-[11px] text-ink-500 mt-1 ml-7">{meta.desc}</p>
            {st.error && <p className="text-[11px] text-cut mt-1 ml-7">{st.error}</p>}
          </div>
        )
      })}
    </aside>
  )
}

function borderCls(status: string): string {
  switch (status) {
    case 'running':
      return 'border-signal/60 bg-signal/5'
    case 'awaiting-approval':
      return 'border-warn/60 bg-warn/5'
    case 'error':
      return 'border-cut/60'
    case 'stale':
      return 'border-warn/40'
    case 'done':
      return 'border-ink-700'
    default:
      return 'border-ink-700 opacity-60'
  }
}

function badgeCls(status: string): string {
  switch (status) {
    case 'done':
      return 'bg-signal text-ink-950'
    case 'running':
      return 'bg-signal/30 text-signal animate-pulse'
    case 'awaiting-approval':
      return 'bg-warn text-ink-950'
    case 'error':
      return 'bg-cut text-ink-950'
    default:
      return 'bg-ink-700 text-ink-400'
  }
}

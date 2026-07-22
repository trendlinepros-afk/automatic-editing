import { useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { estimatePipelineCost, formatUsd } from '../state/cost'
import { STAGE_ORDER, type StageId } from '@shared/types'

const STAGE_META: Record<StageId, { n: number; label: string; desc: string }> = {
  'cut-detect': { n: 1, label: 'Cut dead space', desc: 'Transcribe → cut silence, retakes, repeats' },
  'cut-review': { n: 2, label: 'Cut review', desc: 'AI validates → renders the cut → YOU approve it' },
  transitions: { n: 3, label: 'Transitions', desc: 'After cut approval · major scene changes only' },
  graphics: { n: 4, label: 'Graphics', desc: 'AI plan → your approval → render' },
  audio: { n: 5, label: 'Sound & music', desc: 'SFX + music with auto-ducking' },
  preview: { n: 6, label: 'Preview', desc: 'Final review render' }
}

export default function StageRail() {
  const project = useStore((s) => s.project)
  const settings = useStore((s) => s.settings)
  const [estimate, setEstimate] = useState<{ minutes: number; estUsd: number } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const cost = useMemo(
    () => (project && settings ? estimatePipelineCost(project, settings) : null),
    [project?.transcript, project?.source?.durationSec, settings?.routing, settings?.keysPresent]
  )

  if (!project) return null

  const anyRunning = STAGE_ORDER.some((id) => project.stages[id].status === 'running')

  async function startPipeline() {
    if (!project) return
    if (!project.transcript) {
      const est = await window.zirtola.estimateTranscription(project.id)
      setEstimate(est)
      setConfirming(true)
      return
    }
    window.zirtola.runPipeline(project.id)
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
                window.zirtola.runPipeline(project.id)
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

      {project.stages['cut-review'].status === 'awaiting-approval' && (
        <div className="panel bg-warn/10 border border-warn/50 p-3 text-xs space-y-2">
          <p className="text-ink-200">
            <b>Your review:</b> the cut is loaded in the preview player. Watch it, delete transcript lines or drag cut
            edges, re-render — repeat until it's right. Nothing continues until you approve.
          </p>
          <div className="flex flex-col gap-2">
            <button
              className="btn text-xs"
              disabled={anyRunning}
              onClick={() => window.zirtola.runStage(project.id, 'cut-review')}
              title="Apply your transcript/cut changes and render the cut again"
            >
              ↻ Re-render cut with my changes
            </button>
            <button
              className="btn btn-primary text-xs"
              disabled={anyRunning}
              onClick={() => window.zirtola.approveCuts(project.id)}
              title="Lock this cut and continue: transitions → graphics → sound → preview"
            >
              ✓ Cut approved — continue pipeline
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
                  className="text-[10px] text-signal hover:underline disabled:opacity-40 disabled:no-underline"
                  disabled={anyRunning}
                  onClick={() => window.zirtola.runStage(project.id, id)}
                  title={anyRunning ? 'Wait for the current stage to finish' : 'Re-run this stage only'}
                >
                  re-run
                </button>
              )}
            </div>
            <div className="flex items-baseline justify-between ml-7 mt-1">
              <p className="text-[11px] text-ink-500">{meta.desc}</p>
              {cost && (
                <span className="text-[10px] shrink-0 ml-2 font-mono text-ink-400" title="Estimated cost per run">
                  {cost.perStage[id].local ? 'local' : `~${formatUsd(cost.perStage[id].usd)}`}
                </span>
              )}
            </div>
            {st.error && <p className="text-[11px] text-cut mt-1 ml-7">{st.error}</p>}
          </div>
        )
      })}

      {cost && (
        <div className="mt-1 pt-2 border-t border-ink-700 flex items-baseline justify-between">
          <span className="text-xs text-ink-300">Estimated total / run</span>
          <span className="text-sm font-mono text-signal">~{formatUsd(cost.total)}</span>
        </div>
      )}
      {cost && (
        <p className="text-[10px] text-ink-600 leading-snug">
          Estimate only. Transcription is metered by length (free once cached); AI cost depends on your provider and
          transcript size. Local stages don't cost anything.
        </p>
      )}
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

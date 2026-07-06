import { useStore } from '../state/store'
import PreviewPlayer from '../components/PreviewPlayer'
import StageRail from '../components/StageRail'
import Timeline from '../components/Timeline'
import Transcript from '../components/Transcript'
import RevisionBar from '../components/RevisionBar'
import GraphicsApproval from '../components/GraphicsApproval'
import ShortsPanel from '../components/ShortsPanel'

export default function EditorView({ shortsMode = false }: { shortsMode?: boolean }) {
  const project = useStore((s) => s.project)
  const setView = useStore((s) => s.setView)
  if (!project) {
    return <div className="p-8 text-ink-500">No project open. Go back to the library and pick one.</div>
  }

  // No active clip yet — the pipeline needs a source. Send the user to the
  // media pool to import footage and pick a clip to edit.
  if (!project.source) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="panel max-w-md w-full p-8 text-center">
          <h1 className="font-display text-xl font-bold text-ink-50 mb-1">No clip selected</h1>
          <p className="text-sm text-ink-400 mb-5">
            Import your footage in the Media pool, then choose a clip to start editing.
          </p>
          <button className="btn btn-primary" onClick={() => setView('media')}>
            Go to Media
          </button>
        </div>
      </div>
    )
  }

  if (shortsMode) {
    return <ShortsPanel />
  }

  const awaitingGraphics = project.stages.graphics.status === 'awaiting-approval'

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Top: preview + stage rail */}
      <div className="flex gap-3 p-3 min-h-0" style={{ height: '46%' }}>
        <div className="flex-1 min-w-0">
          <PreviewPlayer />
        </div>
        <StageRail />
      </div>

      {/* Revision input across the middle */}
      <RevisionBar />

      {/* Bottom: the timeline ↔ transcript centerpiece */}
      <div className="flex-1 min-h-0 flex flex-col gap-2 p-3 pt-2">
        <Timeline />
        <Transcript />
      </div>

      {awaitingGraphics && <GraphicsApproval />}
    </div>
  )
}

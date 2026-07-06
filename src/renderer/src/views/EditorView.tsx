import { useStore } from '../state/store'
import PreviewPlayer from '../components/PreviewPlayer'
import StageRail from '../components/StageRail'
import Timeline from '../components/Timeline'
import Transcript from '../components/Transcript'
import RevisionBar from '../components/RevisionBar'
import GraphicsApproval from '../components/GraphicsApproval'
import ShortsPanel from '../components/ShortsPanel'
import AttachSource from '../components/AttachSource'

export default function EditorView({ shortsMode = false }: { shortsMode?: boolean }) {
  const project = useStore((s) => s.project)
  if (!project) {
    return <div className="p-8 text-ink-500">No project open. Go back to the library and pick one.</div>
  }

  // A freshly-named project has no footage yet — prompt to attach it before
  // the editor (preview / timeline / pipeline all need a source video).
  if (!project.source) {
    return <AttachSource />
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

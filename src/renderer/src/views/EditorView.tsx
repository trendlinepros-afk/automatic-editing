import { useStore } from '../state/store'
import PreviewPlayer from '../components/PreviewPlayer'
import StageRail from '../components/StageRail'
import Timeline from '../components/Timeline'
import Transcript from '../components/Transcript'
import RevisionBar from '../components/RevisionBar'
import GraphicsApproval from '../components/GraphicsApproval'
import ShortsPanel from '../components/ShortsPanel'
import Sequencer from '../components/Sequencer'
import LiveLogs from '../components/LiveLogs'

export default function EditorView({ shortsMode = false }: { shortsMode?: boolean }) {
  const project = useStore((s) => s.project)
  if (!project) {
    return <div className="p-8 text-ink-500">No project open. Go back to the library and pick one.</div>
  }

  // No edit built yet — number the imported clips into an order and start the
  // auto-edit. Once the sequence is built the source is set and the pipeline
  // editor below takes over.
  if (!project.source) {
    return <Sequencer />
  }

  if (shortsMode) {
    return <ShortsPanel />
  }

  const awaitingGraphics = project.stages.graphics.status === 'awaiting-approval'

  // Layout (per user sketch): transcript = full-height left column;
  // center column = big preview → revision bar → timeline strip → live logs;
  // pipeline rail stays on the right (the queue panel sits beyond it).
  return (
    <div className="h-full flex min-h-0">
      {/* Left: transcript, full height */}
      <div className="w-[30%] min-w-[340px] max-w-[560px] shrink-0 flex flex-col min-h-0 p-3 pr-0">
        <Transcript />
      </div>

      {/* Center + right */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Preview (big) + pipeline rail */}
        <div className="flex-1 min-h-0 flex gap-3 p-3 pb-2">
          <div className="flex-1 min-w-0">
            <PreviewPlayer />
          </div>
          <StageRail />
        </div>

        {/* Revision input */}
        <RevisionBar />

        {/* Timeline strip */}
        <div className="shrink-0 px-3 pt-2">
          <Timeline />
        </div>

        {/* Live logs along the bottom */}
        <div className="h-44 shrink-0 p-3 pt-2">
          <LiveLogs />
        </div>
      </div>

      {awaitingGraphics && <GraphicsApproval />}
    </div>
  )
}

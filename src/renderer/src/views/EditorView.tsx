import { useEffect, useRef, useState } from 'react'
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

const TRANSCRIPT_W_KEY = 'zirtola.transcriptWidth'
const TRANSCRIPT_W_MIN = 260
const TRANSCRIPT_W_MAX = 900

export default function EditorView({ shortsMode = false }: { shortsMode?: boolean }) {
  const project = useStore((s) => s.project)

  // Draggable transcript column width, remembered across sessions.
  const [transcriptW, setTranscriptW] = useState(() => {
    const saved = Number(localStorage.getItem(TRANSCRIPT_W_KEY))
    return Number.isFinite(saved) && saved >= TRANSCRIPT_W_MIN && saved <= TRANSCRIPT_W_MAX ? saved : 420
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const left = containerRef.current.getBoundingClientRect().left
      setTranscriptW(Math.min(TRANSCRIPT_W_MAX, Math.max(TRANSCRIPT_W_MIN, e.clientX - left)))
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setTranscriptW((w) => {
        localStorage.setItem(TRANSCRIPT_W_KEY, String(w))
        return w
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

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
    <div ref={containerRef} className="h-full flex min-h-0">
      {/* Left: transcript, full height, width draggable via the divider */}
      <div className="shrink-0 flex flex-col min-h-0 p-3 pr-0" style={{ width: transcriptW }}>
        <Transcript />
      </div>

      {/* Drag handle — resize the transcript column */}
      <div
        className="w-1.5 shrink-0 cursor-col-resize my-3 rounded bg-ink-800 hover:bg-signal/60 active:bg-signal transition-colors"
        title="Drag to resize the transcript"
        onMouseDown={(e) => {
          e.preventDefault()
          dragging.current = true
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
        }}
      />

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

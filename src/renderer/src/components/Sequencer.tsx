/**
 * Shown in the editor before an edit has been built. Left: the media pool with
 * a per-clip order dropdown. Right: a preview placeholder, the resulting clip
 * order, and "Start auto-edit" — which stitches the numbered clips in order and
 * runs the AI pipeline. Un-numbered clips are excluded.
 */
import { useState } from 'react'
import { useStore } from '../state/store'
import MediaTree, { flattenVideos } from './MediaTree'
import type { MediaItem } from '@shared/types'

export default function Sequencer() {
  const project = useStore((s) => s.project)
  const applyProjectPush = useStore((s) => s.applyProjectPush)
  const setView = useStore((s) => s.setView)
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  if (!project) return null

  const media = project.media ?? []
  const videos = flattenVideos(media)
  const numbered = videos
    .filter((v) => typeof v.order === 'number')
    .sort((a, b) => (a.order! - b.order!) || a.name.localeCompare(b.name))

  async function importPaths(paths: string[]) {
    if (!project || paths.length === 0) return
    setBusy(true)
    setError(null)
    try {
      applyProjectPush(await window.zirtola.importMedia(project.id, paths))
    } catch (err: any) {
      setError(err?.message ?? 'Could not import that media.')
    } finally {
      setBusy(false)
    }
  }

  async function importFiles() {
    setMenuOpen(false)
    await importPaths(await window.zirtola.pickMediaFiles())
  }
  async function importFolder() {
    setMenuOpen(false)
    const dir = await window.zirtola.pickMediaFolder()
    if (dir) await importPaths([dir])
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.zirtola.pathForFile(f)).filter(Boolean)
    importPaths(paths)
  }

  async function setOrder(item: MediaItem, order: number | null) {
    if (!project) return
    applyProjectPush(await window.zirtola.setMediaOrder(project.id, item.id, order))
  }
  async function remove(item: MediaItem) {
    if (!project) return
    applyProjectPush(await window.zirtola.removeMedia(project.id, item.id))
  }

  async function start() {
    if (!project || numbered.length === 0) return
    setStarting(true)
    setError(null)
    try {
      // Fire-and-forget: the pipeline pushes project updates; once the source
      // (built sequence) lands, the editor swaps to the pipeline view.
      await window.zirtola.startAutoEdit(project.id)
    } catch (err: any) {
      setError(err?.message ?? 'Could not start the edit.')
      setStarting(false)
    }
  }

  return (
    <div className="h-full flex min-h-0">
      {/* Left: media pool with numbering */}
      <div className="w-[400px] shrink-0 border-r border-ink-700 flex flex-col min-h-0">
        <div className="flex items-center justify-between p-3 pb-2">
          <h2 className="font-display font-semibold text-ink-50">Media</h2>
          <div className="relative">
            <button className="btn text-xs" onClick={() => setMenuOpen((v) => !v)} disabled={busy}>
              Import ▾
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 mt-1 z-20 panel bg-ink-800 p-1 w-40 shadow-xl">
                  <button className="block w-full text-left px-3 py-1.5 text-sm rounded hover:bg-ink-700" onClick={importFiles}>
                    Video files…
                  </button>
                  <button className="block w-full text-left px-3 py-1.5 text-sm rounded hover:bg-ink-700" onClick={importFolder}>
                    Folder…
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <p className="px-3 text-[11px] text-ink-500 mb-1">Set each clip's number to order it. Leave blank to skip.</p>
        <div
          className={`flex-1 min-h-0 overflow-y-auto p-2 m-2 mt-1 rounded border border-transparent ${
            dragOver ? 'border-signal bg-signal/5' : ''
          }`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {media.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 pointer-events-none">
              <p className="text-sm text-ink-400">Drag &amp; drop videos or folders</p>
              <p className="text-xs text-ink-500">or use Import.</p>
            </div>
          ) : (
            <MediaTree media={media} numbering videoCount={videos.length} onSetOrder={setOrder} onRemove={remove} />
          )}
        </div>
      </div>

      {/* Right: preview placeholder + sequence + start */}
      <div className="flex-1 min-w-0 flex flex-col p-6 gap-4">
        <div className="panel flex-1 min-h-0 bg-black flex items-center justify-center">
          <div className="text-center p-8">
            <p className="text-ink-400 mb-1">Preview</p>
            <p className="text-sm text-ink-500">Your edited preview appears here after the auto-edit runs.</p>
          </div>
        </div>

        <div className="panel p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-display font-semibold text-ink-50 text-sm">
              Edit order {numbered.length > 0 && <span className="text-ink-500">· {numbered.length} clip(s)</span>}
            </h3>
            <button className="btn btn-primary" onClick={start} disabled={numbered.length === 0 || starting}>
              {starting ? 'Starting…' : '▶ Start auto-edit'}
            </button>
          </div>

          {numbered.length === 0 ? (
            <p className="text-xs text-ink-500">
              Number the clips on the left to include them. They'll be edited in that order; clips left blank are
              skipped.
            </p>
          ) : (
            <ol className="text-sm text-ink-200 space-y-1">
              {numbered.map((v, i) => (
                <li key={v.id} className="flex items-center gap-2">
                  <span className="w-6 text-signal font-mono">{i + 1}.</span>
                  <span className="truncate">{v.name}</span>
                </li>
              ))}
            </ol>
          )}

          {error && <p className="text-xs text-cut mt-2">{error}</p>}
          {starting && (
            <p className="text-[11px] text-ink-500 mt-2">
              Building the sequence and starting the pipeline — watch the Queue on the right for progress.
            </p>
          )}
          <button className="text-xs text-ink-500 hover:text-ink-300 mt-3" onClick={() => setView('media')}>
            ← Back to Media
          </button>
        </div>
      </div>
    </div>
  )
}

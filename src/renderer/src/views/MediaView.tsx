/**
 * Media pool — like a Premiere/Resolve bin. Import multiple videos or whole
 * folders (drag-and-drop or the Import button); the folder structure is kept so
 * the user's own sorting is preserved. Files are referenced IN PLACE — never
 * copied or modified. Pick a clip to make it the active source the AI edits.
 */
import { useState } from 'react'
import { useStore } from '../state/store'
import type { MediaItem } from '@shared/types'

export default function MediaView() {
  const project = useStore((s) => s.project)
  const applyProjectPush = useStore((s) => s.applyProjectPush)
  const setView = useStore((s) => s.setView)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  if (!project) return null

  const media = project.media ?? []
  const activePath = project.source?.path ?? null

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
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.zirtola.pathForFile(f))
      .filter(Boolean)
    importPaths(paths)
  }

  async function makeActive(item: MediaItem) {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      applyProjectPush(await window.zirtola.setProjectSource(project.id, item.path))
      setView('editor')
    } catch (err: any) {
      setError(err?.message ?? 'Could not open that clip.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(item: MediaItem) {
    if (!project) return
    applyProjectPush(await window.zirtola.removeMedia(project.id, item.id))
  }

  return (
    <div className="h-full flex flex-col p-6 max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between mb-1">
        <h1 className="font-display text-2xl font-bold text-ink-50">Media</h1>
        <div className="relative">
          <button className="btn btn-primary" onClick={() => setMenuOpen((v) => !v)} disabled={busy}>
            Import ▾
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 mt-1 z-20 panel bg-ink-800 p-1 w-44 shadow-xl">
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
      <p className="text-xs text-ink-500 mb-2">
        Files are linked in place (read-only) — never copied or modified. 💡 Keep media on a local drive; network
        drives can be slow and unreliable.
      </p>

      {error && <p className="text-xs text-cut mb-2">{error}</p>}

      <div
        className={`panel flex-1 min-h-0 overflow-y-auto p-3 transition-colors ${
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
          <div className="h-full flex flex-col items-center justify-center text-center p-8 pointer-events-none">
            <p className="text-ink-300 mb-1">Drag &amp; drop videos or folders here</p>
            <p className="text-sm text-ink-500">or use the Import button. Folders keep their structure.</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {media.map((item) => (
              <MediaNode
                key={item.id}
                item={item}
                depth={0}
                activePath={activePath}
                busy={busy}
                onEdit={makeActive}
                onRemove={remove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface NodeProps {
  item: MediaItem
  depth: number
  activePath: string | null
  busy: boolean
  onEdit: (i: MediaItem) => void
  onRemove: (i: MediaItem) => void
}

function MediaNode({ item, depth, activePath, busy, onEdit, onRemove }: NodeProps) {
  const [open, setOpen] = useState(true)
  const isFolder = item.kind === 'folder'
  const isActive = !isFolder && activePath === item.path

  return (
    <div>
      <div
        className={`group flex items-center gap-2 rounded px-2 py-1 hover:bg-ink-800 ${isActive ? 'bg-signal/10' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        {isFolder ? (
          <button className="w-4 text-ink-400 shrink-0" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="shrink-0">{isFolder ? '📁' : '🎬'}</span>
        <span className={`flex-1 truncate text-sm ${isActive ? 'text-signal' : 'text-ink-200'}`}>{item.name}</span>

        {isActive && <span className="text-[10px] uppercase tracking-wide text-signal shrink-0">editing</span>}
        {!isFolder && !isActive && (
          <button
            className="text-[11px] text-signal opacity-0 group-hover:opacity-100 hover:underline shrink-0"
            disabled={busy}
            onClick={() => onEdit(item)}
          >
            Edit this clip
          </button>
        )}
        <button
          className="text-[11px] text-ink-500 opacity-0 group-hover:opacity-100 hover:text-cut shrink-0"
          onClick={() => onRemove(item)}
          title="Remove from media pool (does not delete the file)"
        >
          ✕
        </button>
      </div>

      {isFolder && open && item.children && (
        <div>
          {item.children.map((child) => (
            <MediaNode
              key={child.id}
              item={child}
              depth={depth + 1}
              activePath={activePath}
              busy={busy}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  )
}

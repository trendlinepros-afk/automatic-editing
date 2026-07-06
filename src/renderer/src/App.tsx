import { useEffect, useState } from 'react'
import { useStore } from './state/store'
import LibraryView from './views/LibraryView'
import MediaView from './views/MediaView'
import EditorView from './views/EditorView'
import SettingsView from './views/SettingsView'
import FirstRunView from './views/FirstRunView'
import RenderQueuePanel from './components/RenderQueuePanel'
import UpdateModal from './components/UpdateModal'

export default function App() {
  const { view, setView, project, settings, closeProject, refreshProjects, refreshSettings, refreshJobs, upsertJob, applyProjectPush } =
    useStore()
  const [showUpdate, setShowUpdate] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  useEffect(() => {
    refreshProjects()
    refreshSettings()
    refreshJobs()
    const offQueue = window.zirtola.onQueueEvent(upsertJob)
    const offProject = window.zirtola.onProjectEvent(applyProjectPush)
    const offMenu = window.zirtola.onMenuCheckUpdates(() => setShowUpdate(true))
    const offCmd = window.zirtola.onMenuCommand((p) => handleMenuCommand(p, setFlash))
    return () => {
      offQueue()
      offProject()
      offMenu()
      offCmd()
    }
  }, [])

  // Global undo/redo shortcuts — but never hijack native text-undo while the
  // user is typing in an input/textarea/contenteditable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) useStore.getState().redo()
        else useStore.getState().undo()
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        useStore.getState().redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The update dialog (Help → Check for Updates) is available in every state.
  const updateModal = showUpdate && <UpdateModal onClose={() => setShowUpdate(false)} />

  // Wait for settings before deciding; then gate on first-run onboarding.
  if (!settings)
    return (
      <div className="h-screen bg-ink-950 flex items-center justify-center text-ink-500 text-sm">
        Loading Zirtola…
        {updateModal}
      </div>
    )
  if (!settings.onboarded)
    return (
      <>
        <FirstRunView />
        {updateModal}
      </>
    )

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-4 px-4 h-12 bg-ink-900 border-b border-ink-700 shrink-0">
        <button
          className="flex items-baseline gap-2 hover:opacity-90 transition-opacity"
          onClick={() => {
            closeProject()
            refreshProjects()
          }}
          title="Zirtola - AI Video Editor"
        >
          <span className="font-display font-bold text-ink-50 tracking-tight">
            Zir<span className="text-signal">tola</span>
          </span>
          <span className="text-[11px] font-medium uppercase tracking-wider text-ink-400 hidden sm:inline">
            AI Video Editor
          </span>
        </button>
        {project && (
          <span className="text-sm text-ink-400 truncate max-w-md">
            {project.name}
            {project.approved && <span className="ml-2 text-signal">✓ approved</span>}
          </span>
        )}
        <div className="flex-1" />
        <nav className="flex gap-1">
          {project && (
            <button className={navCls(view === 'media')} onClick={() => setView('media')}>
              Media
            </button>
          )}
          {project && (
            <button className={navCls(view === 'editor')} onClick={() => setView('editor')}>
              Editor
            </button>
          )}
          {project?.approved && (
            <button className={navCls(view === 'shorts')} onClick={() => setView('shorts')}>
              Shorts
            </button>
          )}
          <button className={navCls(view === 'settings')} onClick={() => setView('settings')}>
            Settings
          </button>
        </nav>
      </header>

      <main className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          {view === 'library' && <LibraryView />}
          {view === 'media' && <MediaView />}
          {view === 'editor' && <EditorView />}
          {view === 'settings' && <SettingsView />}
          {view === 'shorts' && <EditorView shortsMode />}
        </div>
        <RenderQueuePanel />
      </main>
      {updateModal}
      {flash && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 panel bg-ink-800 px-4 py-2 text-sm text-ink-100 shadow-xl">
          {flash}
        </div>
      )}
    </div>
  )
}

/** Dispatch File-menu commands. Reads fresh store state (the subscription is
 *  registered once), so it never closes over stale project/view. */
async function handleMenuCommand(
  { command, projectId }: { command: string; projectId?: string },
  setFlash: (msg: string | null) => void
): Promise<void> {
  const flash = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash(null), 2200)
  }
  const s = () => useStore.getState()
  try {
    switch (command) {
      case 'new-project':
        s().closeProject()
        s().setView('library')
        s().requestNewProject()
        break
      case 'open-project': {
        const fp = await window.zirtola.pickProjectFile()
        if (!fp) return
        const p = await window.zirtola.importProject(fp)
        await s().refreshProjects()
        await s().openProject(p.id)
        break
      }
      case 'open-project-id':
        if (projectId) await s().openProject(projectId)
        break
      case 'import': {
        const cur = s().project
        if (!cur) return flash('Open a project first to import media.')
        const paths = await window.zirtola.pickMediaFiles()
        if (!paths.length) return
        s().applyProjectPush(await window.zirtola.importMedia(cur.id, paths))
        s().setView('media')
        break
      }
      case 'save': {
        const cur = s().project
        if (!cur) return flash('No project open to save.')
        await window.zirtola.saveProject(cur.id)
        flash('Saved ✓')
        break
      }
      case 'save-as': {
        const cur = s().project
        if (!cur) return flash('No project open to copy.')
        const copy = await window.zirtola.duplicateProject(cur.id)
        await s().refreshProjects()
        await s().openProject(copy.id)
        flash(`Saved as "${copy.name}"`)
        break
      }
    }
  } catch (err: any) {
    flash(err?.message ?? 'That action failed.')
  }
}

function navCls(active: boolean): string {
  return `px-3 py-1 rounded text-sm ${active ? 'bg-ink-700 text-signal' : 'text-ink-400 hover:text-ink-200'}`
}

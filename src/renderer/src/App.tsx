import { useEffect } from 'react'
import { useStore } from './state/store'
import LibraryView from './views/LibraryView'
import EditorView from './views/EditorView'
import SettingsView from './views/SettingsView'
import FirstRunView from './views/FirstRunView'
import RenderQueuePanel from './components/RenderQueuePanel'

export default function App() {
  const { view, setView, project, settings, closeProject, refreshProjects, refreshSettings, refreshJobs, upsertJob, applyProjectPush } =
    useStore()

  useEffect(() => {
    refreshProjects()
    refreshSettings()
    refreshJobs()
    const offQueue = window.zirtola.onQueueEvent(upsertJob)
    const offProject = window.zirtola.onProjectEvent(applyProjectPush)
    return () => {
      offQueue()
      offProject()
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

  // Wait for settings before deciding; then gate on first-run onboarding.
  if (!settings)
    return (
      <div className="h-screen bg-ink-950 flex items-center justify-center text-ink-500 text-sm">Loading Zirtola…</div>
    )
  if (!settings.onboarded) return <FirstRunView />

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-4 px-4 h-12 bg-ink-900 border-b border-ink-700 shrink-0">
        <button
          className="font-display font-bold text-ink-50 tracking-tight hover:text-signal transition-colors"
          onClick={() => {
            closeProject()
            refreshProjects()
          }}
        >
          Zir<span className="text-signal">tola</span>
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
          {view === 'editor' && <EditorView />}
          {view === 'settings' && <SettingsView />}
          {view === 'shorts' && <EditorView shortsMode />}
        </div>
        <RenderQueuePanel />
      </main>
    </div>
  )
}

function navCls(active: boolean): string {
  return `px-3 py-1 rounded text-sm ${active ? 'bg-ink-700 text-signal' : 'text-ink-400 hover:text-ink-200'}`
}

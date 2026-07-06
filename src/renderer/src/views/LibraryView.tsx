import { useState } from 'react'
import { useStore, formatTime } from '../state/store'
import NewProjectModal from '../components/NewProjectModal'

export default function LibraryView() {
  const { projects, settings, refreshProjects, openProject, completeOnboarding } = useStore()
  const [busy, setBusy] = useState<null | 'create' | 'open' | 'folder'>(null)
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)

  // Create a new project from a name — makes a fresh folder inside
  // <master>/Projects and opens the editor, where footage is attached.
  async function createNamed(name: string) {
    setError(null)
    setBusy('create')
    try {
      const project = await window.zirtola.createProject(name)
      await refreshProjects()
      await openProject(project.id)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
      setNaming(false)
    }
  }

  // Open an existing project the user picks manually (its project.json).
  async function openFromDisk() {
    setError(null)
    const filePath = await window.zirtola.pickProjectFile()
    if (!filePath) return
    setBusy('open')
    try {
      const project = await window.zirtola.importProject(filePath)
      await refreshProjects()
      await openProject(project.id)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }

  async function changeFolder() {
    setError(null)
    const dir = await window.zirtola.pickDirectory()
    if (!dir) return
    setBusy('folder')
    try {
      await completeOnboarding(dir)
      await refreshProjects()
    } catch (err: any) {
      setError(err?.message ?? "Couldn't use that folder — pick a different one.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="p-8 max-w-4xl mx-auto overflow-y-auto h-full">
      {/* Master folder + change */}
      <div className="panel bg-ink-850 p-4 mb-5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="label mb-0.5">Projects folder</div>
          <div className="text-xs text-ink-300 font-mono truncate">
            {settings?.projectsDir ?? 'Default location (app data folder)'}
          </div>
          <div className="text-[11px] text-ink-500 mt-0.5">
            Projects and Assets subfolders live here.
          </div>
        </div>
        <button className="btn shrink-0" onClick={changeFolder} disabled={busy !== null}>
          {busy === 'folder' ? 'Changing…' : 'Change Projects Folder'}
        </button>
      </div>

      {/* Primary actions */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="font-display text-2xl font-bold text-ink-50">Recent projects</h1>
        <div className="flex gap-2">
          <button className="btn" onClick={openFromDisk} disabled={busy !== null}>
            {busy === 'open' ? 'Opening…' : 'Open Project…'}
          </button>
          <button className="btn btn-primary" onClick={() => setNaming(true)} disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : '＋ Create New Project'}
          </button>
        </div>
      </div>

      {error && <div className="panel p-4 mb-4 border-cut/50 text-cut text-sm">{error}</div>}

      {projects.length === 0 ? (
        <div className="panel p-12 text-center">
          <p className="text-ink-400 mb-2">No projects yet.</p>
          <p className="text-sm text-ink-500">
            <b>Create New Project</b> to start from a source video, or <b>Open Project</b> to load an existing one.
            Zirtola never modifies your original file — all work happens on copies in the project folder.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {projects.map((p) => (
            <div key={p.id} className="panel p-4 flex items-center gap-4 hover:border-ink-600 transition-colors">
              <button className="flex-1 text-left min-w-0" onClick={() => openProject(p.id)}>
                <div className="font-medium text-ink-50 truncate">{p.name}</div>
                <div className="text-xs text-ink-500 mt-1 truncate">
                  {p.sourcePath ? (
                    <>
                      {formatTime(p.durationSec)} · {new Date(p.updatedAt).toLocaleString()} ·{' '}
                      <span className="font-mono">{p.sourcePath}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-warn">No source video yet</span> · {new Date(p.updatedAt).toLocaleString()}
                    </>
                  )}
                </div>
              </button>
              {p.approved && <span className="text-signal text-sm shrink-0">✓ approved</span>}
              <button
                className="btn-danger btn text-xs shrink-0"
                onClick={async () => {
                  if (confirm(`Delete project "${p.name}"? The source video is untouched.`)) {
                    await window.zirtola.deleteProject(p.id)
                    refreshProjects()
                  }
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {naming && (
        <NewProjectModal busy={busy === 'create'} onCancel={() => setNaming(false)} onConfirm={createNamed} />
      )}
    </div>
  )
}

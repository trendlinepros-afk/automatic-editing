import { useState } from 'react'
import { useStore, formatTime } from '../state/store'

export default function LibraryView() {
  const { projects, refreshProjects, openProject } = useStore()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function newProject() {
    setError(null)
    const sourcePath = await window.zirtola.pickSourceFile()
    if (!sourcePath) return
    setCreating(true)
    try {
      const project = await window.zirtola.createProject('', sourcePath)
      await refreshProjects()
      await openProject(project.id)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-8 max-w-4xl mx-auto overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold text-ink-50">Projects</h1>
        <button className="btn btn-primary" onClick={newProject} disabled={creating}>
          {creating ? 'Reading source…' : '+ New project from video'}
        </button>
      </div>

      {error && (
        <div className="panel p-4 mb-4 border-cut/50 text-cut text-sm">
          {error}
        </div>
      )}

      {projects.length === 0 ? (
        <div className="panel p-12 text-center">
          <p className="text-ink-400 mb-2">No projects yet.</p>
          <p className="text-sm text-ink-500">
            Pick a source video to start. Zirtola never modifies your original file — all work happens on copies in
            the project folder.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {projects.map((p) => (
            <div key={p.id} className="panel p-4 flex items-center gap-4 hover:border-ink-600 transition-colors">
              <button className="flex-1 text-left" onClick={() => openProject(p.id)}>
                <div className="font-medium text-ink-50">{p.name}</div>
                <div className="text-xs text-ink-500 mt-1">
                  {formatTime(p.durationSec)} · {new Date(p.updatedAt).toLocaleString()} ·{' '}
                  <span className="font-mono">{p.sourcePath}</span>
                </div>
              </button>
              {p.approved && <span className="text-signal text-sm shrink-0">✓ approved</span>}
              <button
                className="btn-danger btn text-xs"
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
    </div>
  )
}

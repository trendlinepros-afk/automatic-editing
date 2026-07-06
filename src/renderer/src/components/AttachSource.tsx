/**
 * Shown in the editor for a freshly-named project that has no footage yet.
 * Attaching a source video probes it and unlocks the pipeline.
 */
import { useState } from 'react'
import { useStore } from '../state/store'

export default function AttachSource() {
  const project = useStore((s) => s.project)
  const applyProjectPush = useStore((s) => s.applyProjectPush)
  const closeProject = useStore((s) => s.closeProject)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!project) return null

  async function choose() {
    setError(null)
    const sourcePath = await window.zirtola.pickSourceFile()
    if (!sourcePath || !project) return
    setBusy(true)
    try {
      const updated = await window.zirtola.setProjectSource(project.id, sourcePath)
      applyProjectPush(updated)
    } catch (err: any) {
      setError(err?.message ?? 'Could not read that video. Try a different file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="panel max-w-lg w-full p-8 text-center">
        <h1 className="font-display text-2xl font-bold text-ink-50 mb-1">{project.name}</h1>
        <p className="text-sm text-ink-400 mb-6">
          This project is ready. Add a <b className="text-ink-200">source video</b> to start editing — Zirtola copies
          all work into the project folder and never modifies your original file.
        </p>

        <button className="btn btn-primary" onClick={choose} disabled={busy}>
          {busy ? 'Reading video…' : 'Choose source video…'}
        </button>

        {error && <p className="text-xs text-cut mt-3">{error}</p>}

        <div className="mt-6">
          <button className="text-xs text-ink-500 hover:text-ink-300" onClick={closeProject} disabled={busy}>
            ← Back to projects
          </button>
        </div>
      </div>
    </div>
  )
}

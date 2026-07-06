/**
 * Shown in the editor for a freshly-named project that has no footage yet.
 * The source video is referenced IN PLACE (like Premiere / Resolve) — never
 * copied or modified. Attaching just probes it and unlocks the pipeline.
 */
import { useState } from 'react'
import { useStore } from '../state/store'

/** UNC path (\\server\share) is unambiguously a network location. */
function looksLikeNetworkPath(p: string): boolean {
  return /^\\\\/.test(p) || /^[a-z]+:\/\//i.test(p)
}

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
    if (
      looksLikeNetworkPath(sourcePath) &&
      !confirm(
        'That file looks like it lives on a network or shared drive. Editing from network storage can be slow and unreliable — for best results, copy it to a local drive first.\n\nUse it anyway?'
      )
    ) {
      return
    }
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
        <p className="text-sm text-ink-400 mb-5">
          Add your <b className="text-ink-200">source video</b> from anywhere on your computer. Zirtola links to the
          file <b className="text-ink-200">in place</b> — it never copies, moves, or changes your original. All editing
          is non-destructive, and only the finished export is written out.
        </p>

        <button className="btn btn-primary" onClick={choose} disabled={busy}>
          {busy ? 'Reading video…' : 'Choose source video…'}
        </button>

        {error && <p className="text-xs text-cut mt-3">{error}</p>}

        <p className="text-[11px] text-ink-500 mt-5">
          💡 For best results, keep source files on a local drive. Editing directly from a network or shared drive can
          be slow and unreliable — copy large files to a local disk first.
        </p>

        <div className="mt-5">
          <button className="text-xs text-ink-500 hover:text-ink-300" onClick={closeProject} disabled={busy}>
            ← Back to projects
          </button>
        </div>
      </div>
    </div>
  )
}

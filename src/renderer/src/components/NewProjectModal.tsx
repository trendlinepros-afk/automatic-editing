/**
 * "Name your project" dialog. Confirm creates a folder named after the project
 * inside <master>/Projects; the source video is attached afterward in the
 * editor.
 */
import { useEffect, useRef, useState } from 'react'

interface Props {
  busy: boolean
  onConfirm: (name: string) => void
  onCancel: () => void
}

export default function NewProjectModal({ busy, onConfirm, onCancel }: Props) {
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmed = name.trim()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function confirm() {
    if (trimmed && !busy) onConfirm(trimmed)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => !busy && onCancel()}
      role="dialog"
      aria-modal="true"
    >
      <div className="panel bg-ink-850 w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-bold text-ink-50 mb-1">Name your project</h2>
        <p className="text-xs text-ink-500 mb-4">
          A folder with this name is created inside your <b>Projects</b> folder. You'll land in the Media pool to
          import your footage.
        </p>

        <input
          ref={inputRef}
          className="input w-full"
          placeholder="e.g. Episode 12 — Interview"
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm()
            if (e.key === 'Escape' && !busy) onCancel()
          }}
        />

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={confirm} disabled={!trimmed || busy}>
            {busy ? 'Creating…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

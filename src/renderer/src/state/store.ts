/**
 * Renderer state (zustand): current project, playback, selection, render
 * queue, and undo/redo. Undo/redo is a snapshot stack over the EDL — both
 * manual edits and AI revisions land in the same EDL, so one stack covers
 * both (an AI revision shows up as one undoable step).
 */
import { create } from 'zustand'
import type {
  AppSettings,
  EDL,
  Project,
  ProjectSummary,
  RenderJob,
  TimeRegion
} from '@shared/types'

export type View = 'library' | 'editor' | 'settings' | 'shorts'

interface Selection {
  region: TimeRegion | null
  segmentIds: string[]
}

interface Store {
  view: View
  setView: (v: View) => void

  projects: ProjectSummary[]
  refreshProjects: () => Promise<void>

  project: Project | null
  openProject: (id: string) => Promise<void>
  closeProject: () => void
  applyProjectPush: (p: Project) => void

  // Playback
  currentTime: number
  setCurrentTime: (t: number) => void
  seekRequest: number | null
  seek: (t: number) => void
  clearSeekRequest: () => void

  // Selection (timeline region and/or transcript span)
  selection: Selection
  setSelection: (s: Partial<Selection>) => void
  clearSelection: () => void

  // EDL editing with undo/redo
  past: EDL[]
  future: EDL[]
  mutateEdl: (fn: (edl: EDL) => EDL) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>

  // Render queue
  jobs: RenderJob[]
  refreshJobs: () => Promise<void>
  upsertJob: (j: RenderJob) => void

  // Settings
  settings: AppSettings | null
  refreshSettings: () => Promise<void>
}

export const useStore = create<Store>((set, get) => ({
  view: 'library',
  setView: (view) => set({ view }),

  projects: [],
  refreshProjects: async () => set({ projects: await window.wickedcut.listProjects() }),

  project: null,
  openProject: async (id) => {
    const project = await window.wickedcut.openProject(id)
    set({ project, view: 'editor', past: [], future: [], selection: { region: null, segmentIds: [] } })
  },
  closeProject: () => set({ project: null, view: 'library', past: [], future: [] }),
  applyProjectPush: (p) => {
    const cur = get().project
    if (cur && cur.id === p.id) set({ project: p })
  },

  currentTime: 0,
  setCurrentTime: (currentTime) => set({ currentTime }),
  seekRequest: null,
  seek: (t) => set({ seekRequest: t, currentTime: t }),
  clearSeekRequest: () => set({ seekRequest: null }),

  selection: { region: null, segmentIds: [] },
  setSelection: (s) => set({ selection: { ...get().selection, ...s } }),
  clearSelection: () => set({ selection: { region: null, segmentIds: [] } }),

  past: [],
  future: [],
  mutateEdl: async (fn) => {
    const { project, past } = get()
    if (!project) return
    const before = structuredClone(project.edl)
    const after = fn(structuredClone(project.edl))
    const updated = await window.wickedcut.updateEdl(project.id, after)
    set({ project: updated, past: [...past.slice(-49), before], future: [] })
  },
  undo: async () => {
    const { project, past, future } = get()
    if (!project || past.length === 0) return
    const prev = past[past.length - 1]
    const updated = await window.wickedcut.updateEdl(project.id, prev)
    set({ project: updated, past: past.slice(0, -1), future: [structuredClone(project.edl), ...future.slice(0, 49)] })
  },
  redo: async () => {
    const { project, past, future } = get()
    if (!project || future.length === 0) return
    const next = future[0]
    const updated = await window.wickedcut.updateEdl(project.id, next)
    set({ project: updated, past: [...past.slice(-49), structuredClone(project.edl)], future: future.slice(1) })
  },

  jobs: [],
  refreshJobs: async () => set({ jobs: await window.wickedcut.listJobs() }),
  upsertJob: (j) => {
    const jobs = get().jobs
    const idx = jobs.findIndex((x) => x.id === j.id)
    set({ jobs: idx >= 0 ? jobs.map((x) => (x.id === j.id ? j : x)) : [j, ...jobs] })
  },

  settings: null,
  refreshSettings: async () => set({ settings: await window.wickedcut.getSettings() })
}))

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const d = Math.floor((sec % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

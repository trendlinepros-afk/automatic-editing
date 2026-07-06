/**
 * Renderer state (zustand): current project, playback, selection, render
 * queue, and undo/redo. Undo/redo is a snapshot stack over the EDL — manual
 * edits AND AI revisions land in the same stack: manual edits record history
 * in mutateEdl, and main-process pushes that carry a changed EDL (AI
 * revisions, pipeline stages) record history in applyProjectPush.
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
export { formatTime } from '@shared/time'

export type View = 'library' | 'editor' | 'settings' | 'shorts'

const HISTORY_LIMIT = 50

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

  // Playback (trimmed-timeline seconds — the preview video's clock)
  currentTime: number
  setCurrentTime: (t: number) => void
  seekRequest: number | null
  seek: (t: number) => void
  clearSeekRequest: () => void

  // Selection (SOURCE-timeline region and/or transcript span)
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
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
}

export const useStore = create<Store>((set, get) => {
  /** Single history bookkeeping path shared by mutateEdl/undo/redo. */
  async function commitEdl(edl: EDL, stacks: { past: EDL[]; future: EDL[] }): Promise<void> {
    const { project } = get()
    if (!project) return
    const updated = await window.wickedcut.updateEdl(project.id, edl)
    set({
      project: updated,
      past: stacks.past.slice(-HISTORY_LIMIT),
      future: stacks.future.slice(0, HISTORY_LIMIT)
    })
  }

  return {
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
      if (!cur || cur.id !== p.id) return
      // A push whose EDL differs (AI revision, pipeline stage) becomes an
      // undoable step, keeping one history across manual + AI edits.
      const edlChanged = p.edl.version !== cur.edl.version
      set({
        project: p,
        ...(edlChanged ? { past: [...get().past, cur.edl].slice(-HISTORY_LIMIT), future: [] } : {})
      })
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
      const before = project.edl // never mutated in place — safe to keep as the snapshot
      const after = fn(structuredClone(project.edl))
      await commitEdl(after, { past: [...past, before], future: [] })
    },
    undo: async () => {
      const { project, past, future } = get()
      if (!project || past.length === 0) return
      await commitEdl(past[past.length - 1], {
        past: past.slice(0, -1),
        future: [project.edl, ...future]
      })
    },
    redo: async () => {
      const { project, past, future } = get()
      if (!project || future.length === 0) return
      await commitEdl(future[0], {
        past: [...past, project.edl],
        future: future.slice(1)
      })
    },

    jobs: [],
    refreshJobs: async () => set({ jobs: await window.wickedcut.listJobs() }),
    upsertJob: (j) => {
      const jobs = get().jobs
      const idx = jobs.findIndex((x) => x.id === j.id)
      set({ jobs: idx >= 0 ? jobs.map((x) => (x.id === j.id ? j : x)) : [j, ...jobs] })
    },

    settings: null,
    refreshSettings: async () => set({ settings: await window.wickedcut.getSettings() }),
    saveSettings: async (patch) => set({ settings: await window.wickedcut.updateSettings(patch) })
  }
})

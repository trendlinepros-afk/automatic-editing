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
  /** The view active before navigating to Settings, so Back can return to it. */
  viewBeforeSettings: View

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
  completeOnboarding: (dir: string | null) => Promise<void>
}

export const useStore = create<Store>((set, get) => {
  /**
   * Single history bookkeeping path shared by mutateEdl/undo/redo.
   *
   * The local apply is SYNCHRONOUS — project + stacks update in one set()
   * against the current state, so a main-process push landing during the
   * IPC round trip can never clobber a history entry computed before an
   * await. The reply then reconciles to the canonical project unless
   * something newer was pushed meanwhile (updatedAt comparison).
   */
  async function commitEdl(edl: EDL, mkStacks: (s: { past: EDL[]; future: EDL[] }) => { past: EDL[]; future: EDL[] }): Promise<void> {
    const { project } = get()
    if (!project) return
    set((s) => {
      const stacks = mkStacks({ past: s.past, future: s.future })
      return {
        project: s.project ? { ...s.project, edl } : s.project,
        past: stacks.past.slice(-HISTORY_LIMIT),
        future: stacks.future.slice(0, HISTORY_LIMIT)
      }
    })
    const updated = await window.zirtola.updateEdl(project.id, edl)
    set((s) =>
      s.project && s.project.id === updated.id && s.project.updatedAt <= updated.updatedAt
        ? { project: updated }
        : {}
    )
  }

  return {
    view: 'library',
    viewBeforeSettings: 'library',
    setView: (view) =>
      set((s) => ({
        view,
        viewBeforeSettings: view === 'settings' && s.view !== 'settings' ? s.view : s.viewBeforeSettings
      })),

    projects: [],
    refreshProjects: async () => set({ projects: await window.zirtola.listProjects() }),

    project: null,
    openProject: async (id) => {
      const project = await window.zirtola.openProject(id)
      set({
        project,
        view: 'editor',
        past: [],
        future: [],
        currentTime: 0,
        seekRequest: null,
        selection: { region: null, segmentIds: [] }
      })
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
      const { project } = get()
      if (!project) return
      const before = project.edl // never mutated in place — safe to keep as the snapshot
      const after = fn(structuredClone(project.edl))
      await commitEdl(after, (s) => ({ past: [...s.past, before], future: [] }))
    },
    undo: async () => {
      const { project, past } = get()
      if (!project || past.length === 0) return
      const prev = past[past.length - 1]
      const current = project.edl
      await commitEdl(prev, (s) => ({
        past: s.past.slice(0, -1),
        future: [current, ...s.future]
      }))
    },
    redo: async () => {
      const { project, future } = get()
      if (!project || future.length === 0) return
      const next = future[0]
      const current = project.edl
      await commitEdl(next, (s) => ({
        past: [...s.past, current],
        future: s.future.slice(1)
      }))
    },

    jobs: [],
    refreshJobs: async () => set({ jobs: await window.zirtola.listJobs() }),
    upsertJob: (j) => {
      const jobs = get().jobs
      const idx = jobs.findIndex((x) => x.id === j.id)
      set({ jobs: idx >= 0 ? jobs.map((x) => (x.id === j.id ? j : x)) : [j, ...jobs] })
    },

    settings: null,
    refreshSettings: async () => set({ settings: await window.zirtola.getSettings() }),
    saveSettings: async (patch) => set({ settings: await window.zirtola.updateSettings(patch) }),
    completeOnboarding: async (dir) => set({ settings: await window.zirtola.setProjectsDir(dir) })
  }
})

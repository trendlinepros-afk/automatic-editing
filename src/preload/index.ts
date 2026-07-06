/**
 * Preload — exposes the typed Zirtola API to the renderer over a
 * contextIsolation bridge. No Node primitives leak into the page.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type ZirtolaApi } from '@shared/ipc'
import type { RenderJob, Project } from '@shared/types'

const api: ZirtolaApi = {
  pickSourceFile: () => ipcRenderer.invoke(IPC.pickSourceFile),
  pickProjectFile: () => ipcRenderer.invoke(IPC.pickProjectFile),
  createProject: (name, sourcePath) => ipcRenderer.invoke(IPC.projectCreate, name, sourcePath),
  importProject: (filePath) => ipcRenderer.invoke(IPC.projectImport, filePath),
  openProject: (id) => ipcRenderer.invoke(IPC.projectOpen, id),
  listProjects: () => ipcRenderer.invoke(IPC.projectList),
  deleteProject: (id) => ipcRenderer.invoke(IPC.projectDelete, id),

  runPipeline: (projectId) => ipcRenderer.invoke(IPC.pipelineRun, projectId),
  runStage: (projectId, stage, region) => ipcRenderer.invoke(IPC.pipelineRunStage, projectId, stage, region),
  approveGraphics: (projectId, ids, edits) => ipcRenderer.invoke(IPC.pipelineApproveGraphics, projectId, ids, edits),
  estimateTranscription: (projectId) => ipcRenderer.invoke(IPC.transcriptEstimate, projectId),

  updateEdl: (projectId, edl) => ipcRenderer.invoke(IPC.edlUpdate, projectId, edl),
  submitRevision: (projectId, text, region, segmentIds) =>
    ipcRenderer.invoke(IPC.revisionSubmit, projectId, text, region, segmentIds),

  approveFinal: (projectId) => ipcRenderer.invoke(IPC.approveFinal, projectId),
  exportFinal: (projectId, presetId) => ipcRenderer.invoke(IPC.exportFinal, projectId, presetId),

  generateShorts: (projectId) => ipcRenderer.invoke(IPC.shortsGenerate, projectId),
  refreshShorts: (projectId) => ipcRenderer.invoke(IPC.shortsRefresh, projectId),

  listJobs: () => ipcRenderer.invoke(IPC.queueList),
  cancelJob: (jobId) => ipcRenderer.invoke(IPC.queueCancel, jobId),
  onQueueEvent: (cb) => {
    const listener = (_e: unknown, job: RenderJob) => cb(job)
    ipcRenderer.on(IPC.queueEvent, listener)
    return () => ipcRenderer.removeListener(IPC.queueEvent, listener)
  },

  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  setApiKey: (name, value) => ipcRenderer.invoke(IPC.settingsSetKey, name, value),
  setProjectsDir: (dir) => ipcRenderer.invoke(IPC.settingsSetProjectsDir, dir),
  pickFontFile: () => ipcRenderer.invoke(IPC.settingsPickFont),
  pickDirectory: () => ipcRenderer.invoke(IPC.settingsPickDir),
  pickLogoFile: () => ipcRenderer.invoke(IPC.settingsPickLogo),

  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),

  onProjectEvent: (cb) => {
    const listener = (_e: unknown, project: Project) => cb(project)
    ipcRenderer.on(IPC.projectEvent, listener)
    return () => ipcRenderer.removeListener(IPC.projectEvent, listener)
  }
}

contextBridge.exposeInMainWorld('zirtola', api)

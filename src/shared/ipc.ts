/**
 * IPC channel names + payload typings shared by main, preload, and renderer.
 * One flat namespace, `domain:action`. Renderer-bound push events are suffixed
 * with `:event`.
 */

import type {
  AppSettings,
  BrandKit,
  EDL,
  GraphicEvent,
  Project,
  ProjectSummary,
  RenderJob,
  RevisionInstruction,
  StageId,
  TimeRegion,
  UpdateCheckResult
} from './types'

export const IPC = {
  // Projects
  projectCreate: 'project:create',
  projectOpen: 'project:open',
  projectList: 'project:list',
  projectSave: 'project:save',
  projectDelete: 'project:delete',
  projectDuplicate: 'project:duplicate',
  projectImport: 'project:import',
  projectSetSource: 'project:set-source',
  pickSourceFile: 'project:pick-source',
  pickProjectFile: 'project:pick-file',

  // Media pool
  mediaImport: 'media:import',
  mediaRemove: 'media:remove',
  mediaSetOrder: 'media:set-order',
  pickMediaFiles: 'media:pick-files',
  pickMediaFolder: 'media:pick-folder',

  // Auto-edit (build sequence + run pipeline)
  autoEditStart: 'auto-edit:start',

  // Pipeline
  pipelineRun: 'pipeline:run',
  pipelineRunStage: 'pipeline:run-stage',
  pipelineApproveGraphics: 'pipeline:approve-graphics',
  transcriptEstimate: 'pipeline:transcript-estimate',

  // EDL / edits
  edlUpdate: 'edl:update',
  revisionSubmit: 'revision:submit',

  // Review / approval
  approveFinal: 'project:approve-final',
  exportFinal: 'export:final',

  // Shorts
  shortsGenerate: 'shorts:generate',
  shortsRefresh: 'shorts:refresh',

  // Queue
  queueList: 'queue:list',
  queueCancel: 'queue:cancel',
  queueEvent: 'queue:event',

  // Settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSetKey: 'settings:set-key',
  settingsSetProjectsDir: 'settings:set-projects-dir',
  settingsPickFont: 'settings:pick-font',
  settingsPickDir: 'settings:pick-dir',
  settingsPickLogo: 'settings:pick-logo',

  // Updates
  updateCheck: 'update:check',
  updateInstall: 'update:install',

  // Logs
  logsGet: 'logs:get',
  logsAppend: 'logs:append',

  // Renderer-bound events
  projectEvent: 'project:event',
  menuCheckUpdates: 'menu:check-updates',
  menuCommand: 'menu:command'
} as const

export interface ZirtolaApi {
  // Projects
  pickSourceFile(): Promise<string | null>
  /** Pick a project.json from disk to open an existing project manually. */
  pickProjectFile(): Promise<string | null>
  /** Create a project. A source video is optional — a named project gets its
   *  folder immediately and footage is attached afterward. */
  createProject(name: string, sourcePath?: string): Promise<Project>
  /** Attach (or replace) the active source video on a project. */
  setProjectSource(id: string, sourcePath: string): Promise<Project>

  // Media pool
  /** Import videos/folders (by absolute path) into the project media pool. */
  importMedia(projectId: string, paths: string[]): Promise<Project>
  removeMedia(projectId: string, itemId: string): Promise<Project>
  /** Set (order number) or clear (null) a clip's edit order. */
  setMediaOrder(projectId: string, itemId: string, order: number | null): Promise<Project>
  /** Build the ordered-clip sequence and run the full pipeline. */
  startAutoEdit(projectId: string): Promise<void>
  /** Open a multi-select file dialog for videos; returns absolute paths. */
  pickMediaFiles(): Promise<string[]>
  /** Open a folder dialog; returns the chosen folder path. */
  pickMediaFolder(): Promise<string | null>
  /** Resolve the absolute path of a dropped File (Electron webUtils). */
  pathForFile(file: File): string
  /** Open a project the user picked from disk (its project.json). */
  importProject(filePath: string): Promise<Project>
  openProject(id: string): Promise<Project>
  listProjects(): Promise<ProjectSummary[]>
  deleteProject(id: string): Promise<void>
  /** Explicitly persist a project (menu Save). */
  saveProject(id: string): Promise<Project>
  /** Duplicate a project's edit state into a new project (menu Save As). */
  duplicateProject(id: string): Promise<Project>

  // Pipeline
  runPipeline(projectId: string): Promise<void>
  runStage(projectId: string, stage: StageId, region?: TimeRegion): Promise<void>
  approveGraphics(projectId: string, approvedIds: string[], edits: GraphicEvent[]): Promise<void>
  estimateTranscription(projectId: string): Promise<{ minutes: number; estUsd: number }>

  // Edits
  updateEdl(projectId: string, edl: EDL): Promise<Project>
  submitRevision(
    projectId: string,
    text: string,
    region?: TimeRegion,
    segmentIds?: string[]
  ): Promise<RevisionInstruction>

  // Approval / export
  approveFinal(projectId: string): Promise<void>
  exportFinal(projectId: string, presetId: string): Promise<void>

  // Shorts
  generateShorts(projectId: string): Promise<void>
  refreshShorts(projectId: string): Promise<Project>

  // Queue
  listJobs(): Promise<RenderJob[]>
  cancelJob(jobId: string): Promise<void>
  onQueueEvent(cb: (job: RenderJob) => void): () => void

  // Settings
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  setApiKey(name: 'gemini' | 'openai' | 'deepseek' | 'anthropic' | 'opusclip' | 's3-access' | 's3-secret', value: string): Promise<void>
  /** Set the master projects folder and mark onboarding complete. Pass null to
   *  accept the default location. */
  setProjectsDir(dir: string | null): Promise<AppSettings>
  pickFontFile(): Promise<{ name: string; path: string } | null>
  pickDirectory(): Promise<string | null>
  pickLogoFile(): Promise<string | null>

  // Updates
  checkForUpdates(): Promise<UpdateCheckResult>
  installUpdate(): Promise<void>

  // Logs
  /** The full session log (since app start) as pasteable text. */
  getLogs(): Promise<string>
  /** Forward a renderer-side event into the session log (fire-and-forget). */
  logEvent(level: 'debug' | 'info' | 'warn' | 'error', message: string): void

  // Push events
  onProjectEvent(cb: (project: Project) => void): () => void
  /** Fired when the user picks Help → Check for Updates in the app menu. */
  onMenuCheckUpdates(cb: () => void): () => void
  /** Fired for File-menu commands (new/open/import/save/etc.). */
  onMenuCommand(cb: (payload: { command: string; projectId?: string }) => void): () => void
}

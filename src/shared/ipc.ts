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
  pickSourceFile: 'project:pick-source',

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

  // Project push events
  projectEvent: 'project:event'
} as const

export interface WickedCutApi {
  // Projects
  pickSourceFile(): Promise<string | null>
  createProject(name: string, sourcePath: string): Promise<Project>
  openProject(id: string): Promise<Project>
  listProjects(): Promise<ProjectSummary[]>
  deleteProject(id: string): Promise<void>

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
  setApiKey(name: 'gemini' | 'openai' | 'deepseek' | 'opusclip' | 's3-access' | 's3-secret', value: string): Promise<void>
  /** Set the master projects folder and mark onboarding complete. Pass null to
   *  accept the default location. */
  setProjectsDir(dir: string | null): Promise<AppSettings>
  pickFontFile(): Promise<{ name: string; path: string } | null>
  pickDirectory(): Promise<string | null>
  pickLogoFile(): Promise<string | null>

  // Updates
  checkForUpdates(): Promise<UpdateCheckResult>
  installUpdate(): Promise<void>

  // Push events
  onProjectEvent(cb: (project: Project) => void): () => void
}

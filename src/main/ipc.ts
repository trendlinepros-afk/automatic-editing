/**
 * IPC handler registration — the single boundary between renderer and main.
 * Secrets never cross this boundary; only presence booleans do.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC } from '@shared/ipc'
import type { AppSettings, EDL, GraphicEvent, StageId, TimeRegion } from '@shared/types'
import * as projects from './project'
import { ensureLayout, masterDir } from './storage'
import { getSettingsStore, type SecretName } from './settings'
import { renderQueue, enqueueAndWait } from './queue'
import {
  runFullPipeline,
  runSingleStage,
  replanGraphics,
  approveGraphicsAndRender,
  transcriptEstimate,
  pushProject,
  renderKeep,
  latestArtifact,
  markStaleForEdlChange
} from './pipeline/runner'
import { submitRevision } from './pipeline/revisions'
import { exportFinal } from './media/render'
import { buildAssFile } from './media/captions'
import { generateShorts, refreshShorts } from './shorts/opusclip'
import { checkForUpdates, installUpdate } from './updater'
import { EXPORT_PRESETS } from '@shared/types'

export function registerIpc(): void {
  // -- Projects ------------------------------------------------------------
  ipcMain.handle(IPC.pickSourceFile, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Pick a source video',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.pickProjectFile, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open a Zirtola project',
      filters: [{ name: 'Zirtola project', extensions: ['json'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.projectCreate, (_e, name: string, sourcePath: string) => projects.createProject(name, sourcePath))
  ipcMain.handle(IPC.projectImport, (_e, filePath: string) => projects.importProjectFromFile(filePath))
  ipcMain.handle(IPC.projectOpen, (_e, id: string) => projects.openProject(id))
  ipcMain.handle(IPC.projectList, () => projects.listProjects())
  ipcMain.handle(IPC.projectDelete, (_e, id: string) => projects.deleteProject(id))

  // -- Pipeline ------------------------------------------------------------
  ipcMain.handle(IPC.pipelineRun, async (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    runFullPipeline(project).catch((err) => console.error('[pipeline]', err))
  })

  ipcMain.handle(IPC.pipelineRunStage, async (_e, projectId: string, stage: StageId, region?: TimeRegion) => {
    const project = projects.openProject(projectId)
    // Explicit stage-4 re-run = fresh AI plan behind the approval gate;
    // revisions go through runSingleStage which re-renders without re-planning.
    const run = stage === 'graphics' ? replanGraphics(project) : runSingleStage(project, stage, region)
    run.catch((err) => console.error('[stage]', err))
  })

  ipcMain.handle(IPC.pipelineApproveGraphics, async (_e, projectId: string, approvedIds: string[], edits: GraphicEvent[]) => {
    const project = projects.openProject(projectId)
    approveGraphicsAndRender(project, approvedIds, edits).catch((err) => console.error('[graphics]', err))
  })

  ipcMain.handle(IPC.transcriptEstimate, (_e, projectId: string) => transcriptEstimate(projects.openProject(projectId)))

  // -- EDL / revisions -------------------------------------------------------
  ipcMain.handle(IPC.edlUpdate, (_e, projectId: string, edl: EDL) => {
    const project = projects.openProject(projectId)
    const before = project.edl
    project.edl = { ...edl, version: project.edl.version + 1 }
    // Manual edits invalidate downstream renders exactly like stage re-runs.
    markStaleForEdlChange(project, before, project.edl)
    return projects.saveProject(project)
  })

  ipcMain.handle(IPC.revisionSubmit, async (_e, projectId: string, text: string, region?: TimeRegion, segmentIds?: string[]) => {
    const project = projects.openProject(projectId)
    return submitRevision(project, text, region, segmentIds)
  })

  // -- Approval + final export ----------------------------------------------
  ipcMain.handle(IPC.approveFinal, (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    project.approved = true
    projects.saveProject(project)
    pushProject(project)
  })

  ipcMain.handle(IPC.exportFinal, (_e, projectId: string, presetId: string) => {
    const project = projects.openProject(projectId)
    const preset = EXPORT_PRESETS.find((p) => p.id === presetId)
    // Run the checks INSIDE the job so a failure shows as a failed queue job
    // (visible to the user) instead of a silently-swallowed IPC rejection.
    enqueueAndWait('final-export', preset ? `Final export: ${preset.label}` : 'Final export', project.id, async (ctx) => {
      if (!preset) throw new Error(`Unknown export preset "${presetId}".`)
      const base = latestArtifact(project, 'audio')
      if (!base) throw new Error('Nothing to export yet — run the pipeline first.')
      const ass = project.transcript
        ? buildAssFile(project.workDir, project.transcript, project.edl.captions, project.brandKit, renderKeep(project), {
            width: preset.width,
            height: preset.height
          })
        : null
      project.finalPath = await exportFinal(project, base, ass, preset, {
        signal: ctx.signal,
        onProgress: (f) => ctx.progress(f, preset.label)
      })
      projects.saveProject(project)
      pushProject(project)
    }).catch((err) => console.error('[export]', err))
  })

  // -- Shorts ----------------------------------------------------------------
  ipcMain.handle(IPC.shortsGenerate, (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    enqueueAndWait('opusclip-submit', 'Generate shorts (OpusClip)', project.id, (ctx) => generateShorts(project, ctx)).catch(
      (err) => console.error('[shorts]', err)
    )
  })

  ipcMain.handle(IPC.shortsRefresh, async (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    await refreshShorts(project)
    return project
  })

  // -- Queue -----------------------------------------------------------------
  ipcMain.handle(IPC.queueList, () => renderQueue.list())
  ipcMain.handle(IPC.queueCancel, (_e, jobId: string) => renderQueue.cancel(jobId))
  renderQueue.on('job', (job) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.queueEvent, job)
  })

  // -- Settings ----------------------------------------------------------------
  ipcMain.handle(IPC.settingsGet, () => getSettingsStore().getSettings())
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>) => getSettingsStore().update(patch))
  ipcMain.handle(IPC.settingsSetKey, (_e, name: SecretName, value: string) => getSettingsStore().setSecret(name, value))

  ipcMain.handle(IPC.settingsSetProjectsDir, (_e, dir: string | null) => {
    const store = getSettingsStore()
    let saved
    if (dir) {
      // Validate we can actually create/write the chosen folder before saving.
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      saved = store.update({ projectsDir: dir, onboarded: true })
    } else {
      // null → accept the default location under user-data.
      saved = store.update({ onboarded: true })
    }
    // Scan the master folder for Projects/ and Assets/ subfolders, mapping to
    // them if present and creating them if not.
    ensureLayout(masterDir())
    return saved
  })

  ipcMain.handle(IPC.settingsPickFont, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Pick a font file',
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }],
      properties: ['openFile']
    })
    if (res.canceled) return null
    const p = res.filePaths[0]
    return { name: path.parse(p).name, path: p }
  })

  ipcMain.handle(IPC.settingsPickDir, async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.settingsPickLogo, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Pick a logo image',
      filters: [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // -- Updates ------------------------------------------------------------------
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates())
  ipcMain.handle(IPC.updateInstall, () => installUpdate())
}

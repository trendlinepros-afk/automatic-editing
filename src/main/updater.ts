/**
 * "Check for updates" — the Settings button (and Help menu item) call
 * checkForUpdates(); electron-updater checks GitHub Releases, downloads in
 * the background, and installUpdate() relaunches into the new version.
 * In dev (unpackaged) it reports dev-mode instead of erroring.
 */
import { app } from 'electron'
import type { UpdateCheckResult } from '@shared/types'

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  if (!app.isPackaged) {
    return {
      status: 'dev-mode',
      currentVersion,
      message: `Running unpackaged (dev) build v${currentVersion} — update checks only work in the installed app.`
    }
  }
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo?.version
    if (!latest || latest === currentVersion) {
      return {
        status: 'up-to-date',
        currentVersion,
        message: `You're on the latest version (v${currentVersion}).`
      }
    }
    // autoDownload is on — wait for the download so Install can be offered.
    await new Promise<void>((resolve) => {
      autoUpdater.once('update-downloaded', () => resolve())
      autoUpdater.once('error', () => resolve())
      // If it was already downloaded this session, don't hang.
      setTimeout(resolve, 120000)
    })
    return {
      status: 'downloaded',
      currentVersion,
      latestVersion: latest,
      message: `Version ${latest} downloaded. Click "Restart & install" to update now, or it installs on next quit.`
    }
  } catch (err: any) {
    return {
      status: 'error',
      currentVersion,
      message: `Update check failed: ${err?.message ?? err}. Check your connection and try again.`
    }
  }
}

export async function installUpdate(): Promise<void> {
  const { autoUpdater } = await import('electron-updater')
  autoUpdater.quitAndInstall()
}

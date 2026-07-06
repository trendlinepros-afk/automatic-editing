/**
 * "Check for updates" — the Settings button (and Help menu item) call
 * checkForUpdates(); electron-updater checks GitHub Releases, downloads in
 * the background, and installUpdate() relaunches into the new version.
 * In dev (unpackaged) it reports dev-mode instead of erroring.
 *
 * Robustness notes:
 *  - Uses result.isUpdateAvailable + result.downloadPromise (the canonical
 *    electron-updater contract) instead of version-string comparison.
 *  - autoUpdater is an EventEmitter; an unhandled 'error' event would crash
 *    the main process, so a persistent no-op listener is attached once.
 *  - Concurrent clicks share one in-flight check instead of double-checking.
 */
import { app } from 'electron'
import type { UpdateCheckResult } from '@shared/types'

let updaterReady = false
let downloadedVersion: string | null = null
let inFlight: Promise<UpdateCheckResult> | null = null

async function getUpdater() {
  // electron-updater is CommonJS. Depending on how the main bundle interops
  // it, the `autoUpdater` singleton can arrive as a named export OR nested
  // under `.default` — resolve both so the packaged build never gets
  // `undefined` here (which threw "Cannot set properties of undefined").
  const mod: any = await import('electron-updater')
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater ?? mod.default
  if (!autoUpdater || typeof autoUpdater.checkForUpdates !== 'function') {
    throw new Error('The updater module failed to load. Reinstall the app from the latest release.')
  }
  if (!updaterReady) {
    updaterReady = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    // Never let a background updater error crash the app (EventEmitter throws
    // on unhandled 'error'). Individual checks still surface errors below.
    autoUpdater.on('error', (err: any) => console.warn('[updater]', err?.message ?? err))
    autoUpdater.on('update-downloaded', (info: any) => {
      downloadedVersion = info?.version ?? downloadedVersion
    })
  }
  return autoUpdater
}

export function checkForUpdates(): Promise<UpdateCheckResult> {
  // Share one in-flight check across the Settings button and the Help menu.
  if (inFlight) return inFlight
  inFlight = doCheck().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doCheck(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  if (!app.isPackaged) {
    return {
      status: 'dev-mode',
      currentVersion,
      message: `Running unpackaged (dev) build v${currentVersion} — update checks only work in the installed app.`
    }
  }
  try {
    const autoUpdater = await getUpdater()

    // Already downloaded earlier this session? Offer install immediately.
    if (downloadedVersion) {
      return {
        status: 'downloaded',
        currentVersion,
        latestVersion: downloadedVersion,
        message: `Version ${downloadedVersion} is downloaded and ready. Click "Restart & install" to update now.`
      }
    }

    const result = await autoUpdater.checkForUpdates()
    if (!result || !result.isUpdateAvailable) {
      return {
        status: 'up-to-date',
        currentVersion,
        message: `You're on the latest version (v${currentVersion}).`
      }
    }

    const latest = result.updateInfo.version
    if (result.downloadPromise) {
      // autoDownload is on — downloadPromise resolves when the update is on disk.
      await result.downloadPromise
      downloadedVersion = latest
      return {
        status: 'downloaded',
        currentVersion,
        latestVersion: latest,
        message: `Version ${latest} downloaded. Click "Restart & install" to update now, or it installs on next quit.`
      }
    }
    return {
      status: 'update-available',
      currentVersion,
      latestVersion: latest,
      message: `Version ${latest} is available and will download in the background.`
    }
  } catch (err: any) {
    const detail = String(err?.message ?? err)
    const hint = detail.includes('404')
      ? ' (No published release found — make sure a GitHub Release with installer assets exists, and that the repo is reachable.)'
      : ''
    return {
      status: 'error',
      currentVersion,
      message: `Update check failed: ${detail}${hint} Check your connection and try again.`
    }
  }
}

export async function installUpdate(): Promise<void> {
  if (!downloadedVersion) {
    throw new Error('No update has been downloaded yet. Run "Check for updates" first.')
  }
  const autoUpdater = await getUpdater()
  autoUpdater.quitAndInstall()
}

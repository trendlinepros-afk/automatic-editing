/**
 * Zirtola — Electron main process entry.
 */
import { app, BrowserWindow, protocol, net, shell } from 'electron'
import path from 'path'
import url from 'url'
import { registerIpc } from './ipc'
import { initDb } from './db'
import { getSettingsStore } from './settings'
import { openProjectWorkDirs } from './project'
import { migrateLegacyUserData } from './migrate'
import { buildAppMenu } from './menu'

// Pin the userData directory name so it can NEVER move again if the product's
// display name changes (as it did in the WickedCut → Zirtola rebrand). All
// settings, keys, and the project index live under %APPDATA%\Zirtola and must
// stay there across every future update.
app.setName('Zirtola')

// Register a privileged scheme so the renderer can play files from project
// work dirs (preview.mp4 etc.) without disabling webSecurity.
protocol.registerSchemesAsPrivileged([
  { scheme: 'wcmedia', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } }
])

/** Canonical roots the wcmedia:// scheme is allowed to read from — the app's
 *  user-data dir and the configured projects folder. Anything else is denied
 *  so the scheme can never be used to read arbitrary files off disk. */
function mediaRoots(): string[] {
  const roots = [path.resolve(app.getPath('userData'))]
  const dir = getSettingsStore().getSettings().projectsDir
  if (dir) roots.push(path.resolve(dir))
  // Projects opened from outside the master folder (via "Open Project…") stream
  // their preview from their own work dir.
  for (const wd of openProjectWorkDirs()) roots.push(path.resolve(wd))
  return roots
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0b0d10',
    title: 'Zirtola - AI Video Editor',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://')) shell.openExternal(target)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

// Single-instance lock: a second launch would write the same SQLite DB and
// project files concurrently and corrupt them. Focus the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // wcmedia://<absolute-path> → stream a local file to the <video> element,
    // confined to the app's own media roots (never arbitrary disk paths).
    protocol.handle('wcmedia', (request) => {
      try {
        const decoded = decodeURIComponent(request.url.slice('wcmedia://'.length))
        const resolved = path.resolve(decoded)
        const allowed = mediaRoots().some((r) => resolved === r || resolved.startsWith(r + path.sep))
        if (!allowed) return new Response('Forbidden', { status: 403 })
        return net.fetch(url.pathToFileURL(resolved).toString())
      } catch {
        return new Response('Bad request', { status: 400 })
      }
    })

    // Recover settings orphaned by the rebrand (no-op once set up here).
    migrateLegacyUserData()
    initDb()
    getSettingsStore()
    registerIpc()
    createWindow()
    buildAppMenu()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

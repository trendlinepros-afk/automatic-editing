/**
 * Zirtola — Electron main process entry.
 */
import { app, BrowserWindow, protocol, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import { registerIpc } from './ipc'
import { initDb } from './db'
import { getSettingsStore } from './settings'
import { openProjectWorkDirs } from './project'
import { migrateLegacyUserData } from './migrate'
import { buildAppMenu } from './menu'
import { captureConsole, log } from './log'

// Start the session flight recorder before ANYTHING else runs, so every
// console line, crash, and subsystem event from t=0 lands in "Copy logs".
captureConsole()

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

function mimeForFile(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    default:
      return 'application/octet-stream'
  }
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
    // Honors HTTP Range so <video> can seek and won't stall after the first
    // buffer (the reason plain net.fetch playback stops after a few seconds).
    protocol.handle('wcmedia', async (request) => {
      try {
        const decoded = decodeURIComponent(request.url.slice('wcmedia://'.length))
        const resolved = path.resolve(decoded)
        const allowed = mediaRoots().some((r) => resolved === r || resolved.startsWith(r + path.sep))
        if (!allowed) return new Response('Forbidden', { status: 403 })

        const total = (await fs.promises.stat(resolved)).size
        const type = mimeForFile(resolved)
        const rangeHeader = request.headers.get('Range')

        if (rangeHeader) {
          const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
          let start = m && m[1] ? parseInt(m[1], 10) : 0
          let end = m && m[2] ? parseInt(m[2], 10) : total - 1
          if (!Number.isFinite(start) || start < 0) start = 0
          if (!Number.isFinite(end) || end >= total) end = total - 1
          if (start > end || start >= total) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
          }
          const body = Readable.toWeb(fs.createReadStream(resolved, { start, end })) as ReadableStream
          return new Response(body, {
            status: 206,
            headers: {
              'Content-Type': type,
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes'
            }
          })
        }

        const body = Readable.toWeb(fs.createReadStream(resolved)) as ReadableStream
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' }
        })
      } catch {
        return new Response('Bad request', { status: 400 })
      }
    })

    log.info('app', `Zirtola v${app.getVersion()} starting (packaged=${app.isPackaged}, userData=${app.getPath('userData')})`)
    // Recover settings orphaned by the rebrand (no-op once set up here).
    migrateLegacyUserData()
    initDb()
    getSettingsStore()
    registerIpc()
    createWindow()
    buildAppMenu()
    log.info('app', 'main window created, menu built — ready')

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

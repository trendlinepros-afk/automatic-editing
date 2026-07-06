/**
 * Zirtola — Electron main process entry.
 */
import { app, BrowserWindow, Menu, protocol, net, shell } from 'electron'
import path from 'path'
import url from 'url'
import { registerIpc } from './ipc'
import { initDb } from './db'
import { getSettingsStore } from './settings'

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

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    }
    // Updates live in Settings → Updates (with the install buttons); no menu
    // entry, to avoid a dead-end that can't offer the install action.
  ])
  Menu.setApplicationMenu(menu)
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

    initDb()
    getSettingsStore()
    registerIpc()
    createWindow()
    buildMenu()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

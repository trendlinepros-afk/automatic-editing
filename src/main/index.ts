/**
 * WickedCut — Electron main process entry.
 */
import { app, BrowserWindow, Menu, protocol, net, shell } from 'electron'
import path from 'path'
import url from 'url'
import { registerIpc } from './ipc'
import { initDb } from './db'
import { getSettingsStore } from './settings'
import { checkForUpdates } from './updater'
import { IPC } from '@shared/ipc'

// Register a privileged scheme so the renderer can play files from project
// work dirs (preview.mp4 etc.) without disabling webSecurity.
protocol.registerSchemesAsPrivileged([
  { scheme: 'wcmedia', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } }
])

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0b0d10',
    title: 'WickedCut',
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

function buildMenu(win: BrowserWindow): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ role: 'quit' }]
    },
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
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: async () => {
            const result = await checkForUpdates()
            win.webContents.send(IPC.queueEvent, {
              id: 'update-check',
              kind: 'probe',
              label: result.message,
              projectId: '',
              status: result.status === 'error' ? 'error' : 'done',
              progress: 1,
              createdAt: new Date().toISOString()
            })
          }
        }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  // wcmedia://<absolute-path> → stream local file to the <video> element.
  protocol.handle('wcmedia', (request) => {
    const filePath = decodeURIComponent(request.url.replace('wcmedia://', ''))
    return net.fetch(url.pathToFileURL(filePath).toString())
  })

  initDb()
  getSettingsStore()
  registerIpc()
  const win = createWindow()
  buildMenu(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

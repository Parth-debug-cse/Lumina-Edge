const { app, BrowserWindow, shell } = require('electron')

const uiUrl = 'http://127.0.0.1:5173/'
const uiOrigin = new URL(uiUrl).origin

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#11100f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'http:' || target.protocol === 'https:') {
        void shell.openExternal(target.href).catch(error => {
          console.error('[Electron] Could not open external link:', error)
        })
      }
    } catch (error) {
      console.error('[Electron] Refusing invalid external URL:', error)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== uiOrigin) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })

  void window.loadURL(uiUrl).catch(error => {
    console.error(`[Electron] Could not load ${uiUrl}. Start the Vite dev server first.`, error)
  })
}

app.whenReady().then(() => {
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}).catch(error => {
  console.error('[Electron] Startup failed:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

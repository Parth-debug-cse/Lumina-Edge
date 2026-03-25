const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let apiServerProcess;
let shouldManageAPIServer = false; // Only manage if we started it

// Helper: Check if a port is listening
function isPortOpen(port, timeout = 5000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/supported-formats`, (res) => {
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - startTime < timeout) {
          setTimeout(check, 100);
        } else {
          resolve(false);
        }
      });
      req.end();
    };
    check();
  });
}

// Start the API server (only if not already running)
function startAPIServer() {
  return new Promise((resolve, reject) => {
    // First, check if server is already running
    isPortOpen(1235, 1000).then((isReady) => {
      if (isReady) {
        console.log('API server is already running on port 1235');
        resolve();
        return;
      }

      // Server not running, so we'll start it
      try {
        const apiPath = path.join(__dirname, 'api-server.js');
        apiServerProcess = spawn('node', [apiPath], {
          cwd: __dirname,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });

        shouldManageAPIServer = true;

        apiServerProcess.on('error', (err) => {
          console.error('API server spawn error:', err);
          reject(err);
        });

        // Wait for server to be ready
        const checkReady = async () => {
          const isReady = await isPortOpen(1235, 10000);
          if (isReady) {
            console.log('API server started successfully on port 1235');
            resolve();
          } else {
            reject(new Error('API server failed to start within timeout'));
          }
        };

        setTimeout(checkReady, 500);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Stop the API server gracefully (only if we started it)
function stopAPIServer() {
  if (shouldManageAPIServer && apiServerProcess) {
    console.log('Stopping API server...');
    apiServerProcess.kill('SIGTERM');
    apiServerProcess = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#080810',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Check if we are in dev mode (Vite running on 5173) or production
  const isDev = process.env.NODE_ENV !== 'production' && process.argv.indexOf('--noDevServer') === -1;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    console.log('Ensuring API server is running...');
    await startAPIServer();
    createWindow();
  } catch (err) {
    console.error('Warning: Could not ensure API server is running:', err.message);
    // Still create window so user sees the UI
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAPIServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  stopAPIServer();
});

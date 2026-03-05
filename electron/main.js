const { app, BrowserWindow } = require('electron');
const path = require('path');
const { start } = require('../server');

let mainWindow;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const url = `http://127.0.0.1:${port}`;

  // Prevent redirect loops: block navigations that append the host as a path
  mainWindow.webContents.on('will-redirect', (event, redirectUrl) => {
    if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
      event.preventDefault();
    }
  });

  // Retry loading until the page is ready
  const tryLoad = () => {
    mainWindow.loadURL(url).catch(() => {
      setTimeout(tryLoad, 1000);
    });
  };
  tryLoad();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  start((port) => {
    createWindow(port);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    start((port) => {
      createWindow(port);
    });
  }
});

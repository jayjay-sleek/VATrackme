const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, powerMonitor, Tray, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { getWindowIconPath, getTrayIconImage } = require('./icons.cjs');

// Prevent GPU/renderer issues on some Windows machines and ensure cache/userData is writable.
try {
  // Disable GPU acceleration which avoids GPU cache creation failures on some systems.
  app.disableHardwareAcceleration();
} catch (e) {}

// Ensure the app uses a controlled userData folder inside %APPDATA% that the current user can write.
try {
  const userDataDir = path.join(app.getPath('appData'), 'VA Worker Time Tracker');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  // Tell Electron to use this path for user data before app.whenReady
  app.setPath('userData', userDataDir);
  // Direct Chromium disk cache into that folder to avoid permission problems.
  try {
    app.commandLine.appendSwitch('disk-cache-dir', path.join(userDataDir, 'Cache'));
  } catch (e) {}
} catch (e) {}

const isDev = !app.isPackaged;
const API_BASE_URL = 'https://www.va4hire.ph/app/api/';
let mainWindow;
let tray;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

if (isDev) {
  app.setPath('userData', path.join(__dirname, '..', '.electron-user-data'));
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.va.worker.timetracker');
}

function createWindow() {
  const windowIcon = getWindowIconPath();
  mainWindow = new BrowserWindow({
    width: 880,
    height: 600,
    minWidth: 720,
    minHeight: 480,
    title: 'VA Trackme',
    autoHideMenuBar: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // remove menus for this window
  try {
    if (typeof Menu.setApplicationMenu === 'function') Menu.setApplicationMenu(null);
    if (mainWindow && typeof mainWindow.removeMenu === 'function') mainWindow.removeMenu();
    if (mainWindow && typeof mainWindow.setMenuBarVisibility === 'function') mainWindow.setMenuBarVisibility(false);
  } catch (e) {
    // ignore on platforms where not supported
  }

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    try {
      const { pathToFileURL } = require('node:url');
      const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
      mainWindow.loadURL(pathToFileURL(indexPath).href);
    } catch (e) {
      try {
        const userData = app.getPath('userData');
        const logFile = path.join(userData, 'renderer.log');
        if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERROR: Failed to load index.html - ${e.stack || e}${os.EOL}`);
      } catch (e2) {}
      mainWindow.loadURL('data:text/html,<h2>Failed to load application. Check logs in app user data.</h2>');
    }
  }

  // capture load failures and crashes
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    try {
      const userData = app.getPath('userData');
      const logFile = path.join(userData, 'renderer.log');
      if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
      const line = `[${new Date().toISOString()}] DID_FAIL_LOAD (${errorCode}) ${errorDescription} url=${validatedURL}${os.EOL}`;
      fs.appendFileSync(logFile, line);
    } catch (e) {}
    // show a simple fallback page
    if (!mainWindow.destroyed) {
      mainWindow.loadURL('data:text/html,<h2>Failed to load application. Check logs in app user data.</h2>');
    }
  });

  mainWindow.webContents.on('crashed', () => {
    try {
      const userData = app.getPath('userData');
      const logFile = path.join(userData, 'renderer.log');
      const line = `[${new Date().toISOString()}] RENDERER CRASHED${os.EOL}`;
      if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
      fs.appendFileSync(logFile, line);
    } catch (e) {}
  });
}

function createTray() {
  try {
    tray = new Tray(getTrayIconImage());
  } catch (e) {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('VA Trackme');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => mainWindow?.show() },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

if (gotTheLock) app.whenReady().then(() => {
  // remove default application menu globally
  try {
    if (typeof Menu.setApplicationMenu === 'function') Menu.setApplicationMenu(null);
  } catch (e) {}
  createWindow();
  createTray();

  // enable auto-run on login for Windows and macOS
  try {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: [],
      });
    }
  } catch (e) {
    // ignore if not supported
  }

  // logging from renderer
  ipcMain.on('renderer-log', (_event, payload) => {
    try {
      const userData = app.getPath('userData');
      if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
      const logFile = path.join(userData, 'renderer.log');
      const line = `[${new Date().toISOString()}] ${payload && payload.level ? payload.level.toUpperCase() : 'INFO'}: ${payload && payload.message ? payload.message : JSON.stringify(payload)}${os.EOL}`;
      fs.appendFileSync(logFile, line);
    } catch (e) {
      // ignore
    }
  });

  // open external links from renderer
  ipcMain.handle('desktop:open-external', async (_event, url) => {
    try {
      const { shell } = require('electron');
      await shell.openExternal(String(url));
      return { ok: true };
    } catch (e) {
      try { console.error('open-external error', e); } catch (_) {}
      return { ok: false, error: String(e) };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
  // try to start global input listener (iohook) for global keystrokes/mouse
  try {
    const iohook = require('iohook');
    iohook.on('keydown', () => {
      try { mainWindow && mainWindow.webContents && mainWindow.webContents.send('global-input', { type: 'keydown' }); } catch (e) {}
    });
    iohook.on('mousedown', () => {
      try { mainWindow && mainWindow.webContents && mainWindow.webContents.send('global-input', { type: 'mouseclick' }); } catch (e) {}
    });
    iohook.on('mousemove', () => {
      try { mainWindow && mainWindow.webContents && mainWindow.webContents.send('global-input', { type: 'mousemove' }); } catch (e) {}
    });
    iohook.start();
    console.log('iohook started for global input');
  } catch (e) {
    try { console.error('iohook not available', e); } catch (_) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('desktop:get-idle-seconds', () => powerMonitor.getSystemIdleTime());

ipcMain.handle('desktop:capture-screen', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1440, height: 900 },
  });

  const primary = sources[0];
  if (!primary) {
    return null;
  }

  return {
    filename: `capture-${Date.now()}.png`,
    mimeType: 'image/png',
    dataUrl: primary.thumbnail.toDataURL(),
  };
});

function logDetection(message) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'detection.log'), `[${new Date().toISOString()}] ${message}${os.EOL}`);
  } catch (e) {}
}

function tryRequireActiveWin() {
  try {
    return require('active-win');
  } catch (primaryError) {
    const candidates = [
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'active-win'),
      path.join(__dirname, '..', 'node_modules', 'active-win'),
    ];
    for (const candidate of candidates) {
      try {
        return require(candidate);
      } catch (e) {
        // try next candidate
      }
    }
    throw primaryError;
  }
}

function mapActiveWinResult(win) {
  return {
    processId: win.owner && win.owner.processId ? win.owner.processId : 0,
    windowHandle: win.id || '',
    windowTitle: win.title || '',
    moduleName: win.owner && win.owner.name ? win.owner.name : app.name,
    moduleFilename: win.owner && win.owner.path ? win.owner.path : process.execPath,
    memoryUsage: 0,
    pagedMemorySize: 0,
  };
}

function getMacActiveWindowViaOsascript() {
  const { execFileSync } = require('child_process');
  const script = [
    'tell application "System Events"',
    '  tell (first application process whose frontmost is true)',
    '    set appName to name',
    '    set winTitle to ""',
    '    try',
    '      if (count of windows) > 0 then',
    '        set winTitle to name of window 1',
    '      end if',
    '    end try',
    '    return appName & "|||" & winTitle',
    '  end tell',
    'end tell',
  ].join('\n');
  const raw = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 3000 }).trim();
  const sep = raw.indexOf('|||');
  const appName = sep >= 0 ? raw.slice(0, sep) : raw;
  const winTitle = sep >= 0 ? raw.slice(sep + 3) : '';
  return {
    processId: 0,
    windowHandle: '',
    windowTitle: winTitle || appName,
    moduleName: appName,
    moduleFilename: '',
    memoryUsage: 0,
    pagedMemorySize: 0,
  };
}

ipcMain.handle('desktop:get-active-window', async () => {
  // First try native active-win (if installed)
  try {
    const activeWin = tryRequireActiveWin();
    const win = await activeWin();
    if (win) {
      const out = mapActiveWinResult(win);
      logDetection(`native: ${JSON.stringify(out)}`);
      return out;
    }
  } catch (e) {
    logDetection(`active-win not available: ${String(e)}`);
  }

  // macOS AppleScript fallback - requires Accessibility permission
  if (process.platform === 'darwin') {
    try {
      const out = getMacActiveWindowViaOsascript();
      logDetection(`osascript: ${JSON.stringify(out)}`);
      return out;
    } catch (e) {
      logDetection(`osascript failed: ${String(e)}`);
    }
  }

  // PowerShell fallback (Windows only) - reads foreground window title and process info
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@;
$h = [Win]::GetForegroundWindow();
$sb = New-Object System.Text.StringBuilder 1024;
[Win]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null;
[Win]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null;
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue;
$path = $proc.Path -as [string];
$out = @{ title = $sb.ToString(); pid = $pid; processName = $proc.ProcessName; processPath = $path };
Write-Output (ConvertTo-Json $out -Compress);
`;
      const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
      const parsed = JSON.parse(raw.trim());
      const out = {
        processId: parsed.pid || 0,
        windowHandle: '',
        windowTitle: parsed.title || '',
        moduleName: parsed.processName || parsed.title || app.name,
        moduleFilename: parsed.processPath || process.execPath,
        memoryUsage: 0,
        pagedMemorySize: 0,
      };
      logDetection(`powershell: ${JSON.stringify(out)}`);
      return out;
    } catch (e) {
      logDetection(`powershell failed: ${String(e)}`);
    }
  }

  // Final fallback
  const fallback = {
    processId: 0,
    windowHandle: '',
    windowTitle: app.name,
    moduleName: app.name,
    moduleFilename: process.execPath,
    memoryUsage: 0,
    pagedMemorySize: 0,
  };
  logDetection(`fallback: ${JSON.stringify(fallback)}`);
  return fallback;
});

ipcMain.handle('desktop:ping-api', async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(API_BASE_URL, { method: 'GET', redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    return { ok: true, status: response.status };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('api:request', async (_event, request) => {
  const url = new URL(request.path.replace(/^\/+/, ''), API_BASE_URL);

  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const options = {
    method: request.method ?? 'GET',
    redirect: 'follow',
    signal: controller.signal,
  };

  if (request.bodyType === 'form') {
    options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    options.body = new URLSearchParams(request.body ?? {});
  }

  if (request.bodyType === 'multipart') {
    const form = new FormData();

    for (const [key, value] of Object.entries(request.fields ?? {})) {
      form.set(key, String(value));
    }

    if (request.file) {
      const buffer = Buffer.from(request.file.dataUrl.split(',')[1] ?? '', 'base64');
      form.set('file', new Blob([buffer], { type: request.file.mimeType }), request.file.filename);
    }

    options.body = form;
  }

  try {
    const response = await fetch(url, options);
    clearTimeout(timeout);
    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch (_error) {
      return {
        error_va_code: response.ok ? 0 : response.status,
        error_message: text || response.statusText,
      };
    }
  } catch (e) {
    clearTimeout(timeout);
    return {
      error_va_code: -1,
      error_message: 'Unable to reach server. Check your internet connection.',
      network_error: true,
    };
  }
});

// lightweight local HTTP receiver for browser extension (tab URLs)
if (gotTheLock) try {
  const http = require('node:http');
  const receiverPort = 42816;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/tab') {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          // Expect payload: { authtoken?, trackerId?, browser, site_link, title, visit_date_time }
          const query = {
            authtoken: payload.authtoken || '',
            type: 'tab',
          };
          const apiReq = {
            method: 'POST',
            path: 'postdata/',
            query,
            bodyType: 'form',
            body: {},
            fields: {},
          };
          // Build Sites as array handled by API: we will send Sites[0][site_link], Sites[0][title], Sites[0][visit_date_time], Sites[0][browser]
          apiReq.fields = {
            'Sites[0][site_link]': payload.site_link || payload.url || '',
            'Sites[0][title]': payload.title || '',
            'Sites[0][visit_date_time]': payload.visit_date_time || new Date().toISOString(),
            'Sites[0][browser]': payload.browser || 'chrome',
          };
          // Use node fetch to forward
          const fetch = global.fetch || require('node-fetch');
          const url = new URL('postdata/', API_BASE_URL);
          if (apiReq.query && apiReq.query.authtoken) {
            url.searchParams.set('authtoken', apiReq.query.authtoken);
          }
          // send as form-data urlencoded
          const form = new URLSearchParams();
          for (const [k, v] of Object.entries(apiReq.fields)) form.set(k, String(v));
          await fetch(url.toString(), { method: 'POST', body: form });
        } catch (e) {
          try { console.error('receiver error', e); } catch (_) {}
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      try { console.warn('Tab receiver port', receiverPort, 'already in use'); } catch (_) {}
      return;
    }
    try { console.error('Tab receiver error', err); } catch (_) {}
  });
  server.listen(receiverPort, '127.0.0.1', () => {
    try { console.log('Tab receiver listening on', receiverPort); } catch (_) {}
  });
} catch (e) {
  // ignore if http not available
}

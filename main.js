'use strict';

const { app, BrowserWindow, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const APP_URL = 'https://nl.onajlikezz.xyz/app/v529/index.php';
const APP_ORIGIN = getAppOrigin(APP_URL);
const OFFLINE_FILE = path.join(__dirname, 'offline.html');
let mainWindow = null;
let keyWindow = null;
let steamPathPromise = null;
let loadingOfflinePage = false;

function getAppOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('NIGHTLIGHT_APP_URL must be a valid URL.');
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('NIGHTLIGHT_APP_URL must use HTTPS.');
  }
  if (parsed.protocol !== 'https:' && !isLocalOrigin(parsed.origin)) {
    throw new Error('HTTP is allowed only for localhost development.');
  }
  return parsed.origin;
}

function isLocalOrigin(origin) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// ---------- Paths ----------
const LOCATIONS_FILE  = () => path.join(app.getPath('userData'), 'game_locations.json');
const STEAM_PATH_FILE = () => path.join(app.getPath('userData'), 'steam_path.txt');

// ---------- Windows exclusion marker ----------
// Marker file name written into the game folder when an exclusion is added.
// If it exists, the UI shows "Remove from exclusions".
const EXCLUSION_MARKER = 'nl.winexc';

function hasExclusionMarker(folderPath) {
  try {
    if (!folderPath) return false;
    return fs.existsSync(path.join(folderPath, EXCLUSION_MARKER));
  } catch {
    return false;
  }
}

function writeExclusionMarker(folderPath) {
  try {
    const markerPath = path.join(folderPath, EXCLUSION_MARKER);
    fs.writeFileSync(
      markerPath,
      'Nightlight Defender exclusion marker\n' + new Date().toISOString() + '\n',
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

function removeExclusionMarker(folderPath) {
  try {
    const markerPath = path.join(folderPath, EXCLUSION_MARKER);
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    return true;
  } catch {
    return false;
  }
}

// ---------- Elevated PowerShell (UAC prompt) ----------
/**
 * Runs an inner PowerShell script in an elevated child process.
 * Windows shows the standard UAC "Do you want to allow...?" prompt.
 *
 * Resolves with:
 *   { ok: true }
 *   { ok: false, error: 'uac_denied' }               → user clicked "No"
 *   { ok: false, error: 'unsupported' }              → non-Windows
 *   { ok: false, error: 'temp_write_failed', message }
 *   { ok: false, error: 'failed', message }          → inner script errored
 */
function runElevatedPowerShell(innerScript, timeoutMs = 120000) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ ok: false, error: 'unsupported' });
    }

    // Write the inner script to a temp file so we don't have to escape
    // nested quotes into a single -Command string.
    const tmpDir = app.getPath('temp');
    const tmpFile = path.join(
      tmpDir,
      `nl-elev-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`
    );

    const wrapped = `
$ErrorActionPreference = 'Stop'
try {
  ${innerScript}
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

    try {
      fs.writeFileSync(tmpFile, wrapped, 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: 'temp_write_failed', message: e.message });
    }

    // Outer script: launch the inner script elevated via Start-Process -Verb RunAs.
    // -Wait + -PassThru lets us read the child's exit code.
    // If the user clicks "No" on the UAC prompt, Start-Process throws with
    // HResult 0x800704C7 (ERROR_CANCELLED = 1223). We surface that as exit 1223.
    const outerScript = `
try {
  $proc = Start-Process -FilePath 'powershell.exe' ` +
      `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${tmpFile.replace(/'/g, "''")}') ` +
      `-Verb RunAs -WindowStyle Hidden -PassThru -Wait -ErrorAction Stop
  exit $proc.ExitCode
} catch {
  if ($_.Exception.HResult -eq -2147023673) { exit 1223 }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', outerScript],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch {}

        if (error) {
          const code = typeof error.code === 'number' ? error.code : 0;
          const combined = (String(stderr || '') + ' ' + String(error.message || '')).trim();

          if (
            code === 1223 ||
            /\b1223\b/.test(combined) ||
            /canceled by the user/i.test(combined) ||
            /operation was canceled/i.test(combined)
          ) {
            return resolve({ ok: false, error: 'uac_denied' });
          }

          return resolve({
            ok: false,
            error: 'failed',
            message: combined.slice(0, 500) || 'Unknown PowerShell error',
          });
        }

        resolve({ ok: true });
      }
    );
  });
}

// ---------- Steam helpers ----------
async function findSteamPath() {
  try {
    if (fs.existsSync(STEAM_PATH_FILE())) {
      const saved = fs.readFileSync(STEAM_PATH_FILE(), 'utf8').trim();
      if (saved && fs.existsSync(saved)) return saved;
    }
  } catch (e) {}

  if (steamPathPromise) return steamPathPromise;
  steamPathPromise = (async () => {
    if (process.platform !== 'win32') return null;
    const registryPaths = await Promise.all([
      queryRegistry('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
      queryRegistry('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    ]);
    const candidates = [...new Set([
      ...registryPaths,
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
    ].filter(Boolean))];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(path.join(candidate, 'steam.exe'))) return candidate;
      } catch { }
    }
    return null;
  })();
  return steamPathPromise;
}

function isAllowedAppUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === APP_ORIGIN && ['https:', 'http:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(value) {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isAllowedDiscordOauthUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'discord.com';
  } catch {
    return false;
  }
}

function isOfflineFileUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'file:' && path.resolve(decodeURIComponent(parsed.pathname.replace(/^\/(?:([a-zA-Z]:))/i, '$1'))) === path.resolve(OFFLINE_FILE);
  } catch {
    return false;
  }
}

function senderIsMain(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  return Boolean(senderWindow && senderWindow === mainWindow);
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show();
  }
}

function loadOfflinePage(errorCode, description) {
  if (!mainWindow || mainWindow.isDestroyed() || loadingOfflinePage) return;
  console.error(`Nightlight is loading offline.html: ${description || 'connection failed'} (${Number(errorCode) || 0})`);
  loadingOfflinePage = true;
  const loadPromise = fs.existsSync(OFFLINE_FILE)
    ? mainWindow.loadFile(OFFLINE_FILE)
    : Promise.reject(new Error(`Missing offline page: ${OFFLINE_FILE}`));
  loadPromise
    .catch((error) => console.error('Nightlight offline page failed to load:', error.message))
    .finally(() => {
      loadingOfflinePage = false;
      showMainWindow();
    });
}

function retryConnection() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  loadingOfflinePage = false;
  mainWindow.loadURL(APP_URL).catch((error) => loadOfflinePage(0, error.message));
  return true;
}

function getMachineGuid() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      windowsHide: true,
      timeout: 5000,
    }, (error, stdout) => {
      if (error) return resolve('');
      const match = String(stdout).match(/MachineGuid\s+REG_SZ\s+(.+)/i);
      resolve(match ? match[1].trim() : '');
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#08060b',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      webSecurity: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', showMainWindow);
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  const showFallback = setTimeout(showMainWindow, 5000);
  mainWindow.once('closed', () => {
    clearTimeout(showFallback);
    if (keyWindow && !keyWindow.isDestroyed()) {
      try { keyWindow.close(); } catch (e) {}
      keyWindow = null;
    }
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedDiscordOauthUrl(url)) {
      return { action: 'allow' };
    }
    if (isAllowedExternalUrl(url) && !isAllowedAppUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url) && !isAllowedDiscordOauthUrl(url) && !isOfflineFileUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !validatedURL || isOfflineFileUrl(validatedURL)) return;
    console.error(`Nightlight failed to load ${validatedURL}: ${description} (${errorCode})`);
    if (isAllowedAppUrl(validatedURL)) loadOfflinePage(errorCode, description);
  });

  async function loadAppWithMachine() {
    const machineGuid = await getMachineGuid();
    const url = new URL(APP_URL);
    if (machineGuid) url.searchParams.set('machine', machineGuid);
    mainWindow.loadURL(url.toString()).catch((error) => {
      console.error('Nightlight initial load failed:', error);
      loadOfflinePage(0, error.message);
    });
  }
  loadAppWithMachine();

  return mainWindow;
}

function sendWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('nightlight:window-state', {
      maximized: mainWindow.isMaximized(),
    });
  }
}

function validText(value, max = 300) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes(String.fromCharCode(0))
  );
}

function queryRegistry(key, value) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', key, '/v', value], {
      windowsHide: true,
      timeout: 5000,
    }, (error, stdout) => {
      if (error) return resolve(null);
      const match = String(stdout).match(new RegExp(`${value}\\s+REG_SZ\\s+(.+)`, 'i'));
      return resolve(match ? match[1].trim().replace(/\//g, '\\') : null);
    });
  });
}

function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const drives = [];
  for (let code = 67; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(drive)) drives.push(drive);
    } catch { }
  }
  return drives;
}

async function steamLibraries() {
  const steamPath = await findSteamPath();
  const libraries = new Set();
  if (steamPath) {
    libraries.add(steamPath);
    const vdf = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    try {
      if (fs.existsSync(vdf)) {
        const content = fs.readFileSync(vdf, 'utf8');
        const regex = /"path"\s+"([^"]+)"/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
          libraries.add(match[1].replace(/\\\\/g, '\\'));
        }
      }
    } catch { }
  }
  for (const drive of listDrives()) {
    for (const root of ['SteamLibrary', 'Steam', 'Games\\SteamLibrary', 'Program Files (x86)\\Steam']) {
      const candidate = path.join(drive, root);
      try {
        if (fs.existsSync(path.join(candidate, 'steamapps'))) libraries.add(candidate);
      } catch { }
    }
  }
  return [...libraries];
}

async function detectGameInstall(appId, executable) {
  const id = String(appId || '').replace(/[^\d]/g, '').slice(0, 20);

  // Preserve the full relative path, not just the basename
  const raw = typeof executable === 'string'
    ? executable.trim().replace(/[\\/]+/g, path.sep)
    : '';
  const exe = raw ? path.basename(raw).slice(0, 120) : '';
  const relExe = raw.slice(0, 260);

  const libraries = await steamLibraries();

  // --- 1. Steam manifest lookup ---
  for (const library of libraries) {
    try {
      const manifest = path.join(library, 'steamapps', `appmanifest_${id}.acf`);
      if (!id || !fs.existsSync(manifest)) continue;
      const content = fs.readFileSync(manifest, 'utf8');
      const match = content.match(/"installdir"\s+"([^"]+)"/i);
      if (!match) continue;

      const folder = path.join(library, 'steamapps', 'common', match[1].replace(/\\\\/g, '\\'));
      if (!fs.existsSync(folder)) continue;

      // Prefer the full relative path if it exists
      if (relExe && fs.existsSync(path.join(folder, relExe))) {
        return { path: folder, method: 'manifest' };
      }
      if (exe && fs.existsSync(path.join(folder, exe))) {
        return { path: folder, method: 'manifest' };
      }
      // Manifest says the game is here — trust it even if the exe check fails
      return { path: folder, method: 'manifest' };
    } catch { }
  }

  if (!exe) return null;

  // --- 2. Scan for the exe in common folders ---
  for (const library of libraries) {
    const common = path.join(library, 'steamapps', 'common');
    try {
      if (!fs.existsSync(common)) continue;
      for (const entry of fs.readdirSync(common, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const folder = path.join(common, entry.name);

        if (relExe && fs.existsSync(path.join(folder, relExe))) {
          return { path: folder, method: 'scan' };
        }
        if (fs.existsSync(path.join(folder, exe))) {
          return { path: folder, method: 'scan' };
        }
      }
    } catch { }
  }
  return null;
}

function loadLocations() {
  try {
    const file = LOCATIONS_FILE();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocation(appId, folder) {
  try {
    const data = loadLocations();
    data[String(appId)] = String(folder);
    fs.mkdirSync(path.dirname(LOCATIONS_FILE()), { recursive: true });
    fs.writeFileSync(LOCATIONS_FILE(), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function parseArguments(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  if (value.length > 500 || value.includes(String.fromCharCode(0))) {
    throw new Error('Launch arguments are invalid.');
  }
  const args = [];
  let current = '';
  let quoted = false;
  let backslashes = 0;
  for (const character of value.trim()) {
    if (character === '\\') { backslashes += 1; continue; }
    if (character === '"') {
      current += '\\'.repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) current += '"';
      else quoted = !quoted;
      backslashes = 0;
      continue;
    }
    current += '\\'.repeat(backslashes);
    backslashes = 0;
    if (/\s/.test(character) && !quoted) {
      if (current) { args.push(current); current = ''; }
    } else {
      current += character;
    }
  }
  current += '\\'.repeat(backslashes);
  if (quoted) throw new Error('Launch arguments contain an unmatched quote.');
  if (current) args.push(current);
  if (args.length > 32 || args.some((argument) => argument.length > 260)) {
    throw new Error('Too many or overly long launch arguments.');
  }
  return args;
}

function resolveLaunchTarget(folder, executable, location) {
  if (!validText(folder, 500)) return { error: 'A valid game folder is required.' };
  const root = path.resolve(folder);
  const configured = typeof location === 'string' && location.trim()
    ? location.trim().replace(/^[\\/]+/, '')
    : (typeof executable === 'string' ? executable.trim() : '');
  if (!validText(configured, 260)) return { error: 'No launch file is configured.' };
  if (path.isAbsolute(configured) || /^[a-zA-Z]:/.test(configured) || configured.startsWith('\\\\')) {
    return { error: 'The launch file must be relative to the game folder.' };
  }
  const normalized = path.normalize(configured.replace(/[\\/]+/g, path.sep));
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return { error: 'The launch file cannot leave the game folder.' };
  }
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { error: 'The launch file is outside the selected game folder.' };
  }
  const extension = path.extname(target).toLowerCase();
  if (!['.exe', '.bat', '.cmd'].includes(extension)) {
    return { error: 'Only .exe, .bat, and .cmd launch files are supported.' };
  }
  return { root, target, extension };
}

function startDetached(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.on('error', (err) => {
    console.error('spawn error:', err);
    throw err;
  });
  child.unref();
}

async function launchGame(options) {
  const input = options && typeof options === 'object' ? options : {};
  const appId = String(input.appId || '').replace(/[^\d]/g, '').slice(0, 20);
  const resolved = resolveLaunchTarget(input.folder, input.executable, input.location);
  let args = [];

  if (!resolved.error) {
    if (!fs.existsSync(resolved.target)) {
      return { ok: false, code: 'TARGET_NOT_FOUND', error: 'The configured launch file was not found.' };
    }
    try {
      args = parseArguments(input.arguments);
      if (resolved.extension === '.exe') {
        startDetached(resolved.target, args, path.dirname(resolved.target));
      } else {
        const commandProcessor = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
        startDetached(commandProcessor, ['/d', '/s', '/c', resolved.target, ...args], path.dirname(resolved.target));
      }
      return { ok: true, method: 'direct', target: path.basename(resolved.target) };
    } catch (error) {
      return { ok: false, code: 'LAUNCH_FAILED', error: error.message };
    }
  }

  if (appId && (!validText(input.folder, 500) || (!input.location && !input.executable))) {
    try {
      await shell.openExternal(`steam://rungameid/${appId}`);
      return { ok: true, method: 'steam' };
    } catch (error) {
      return { ok: false, code: 'STEAM_FAILED', error: error.message };
    }
  }

  return { ok: false, code: 'INVALID_TARGET', error: resolved.error };
}

app.setAsDefaultProtocolClient('nightlight');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const window = createWindow();
    window.on('maximize', sendWindowState);
    window.on('unmaximize', sendWindowState);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error('Nightlight startup failed:', error);
    dialog.showErrorBox('Nightlight startup failed', error.message);
    app.quit();
  });
}

// ---------- IPC: Steam / window / app ----------
ipcMain.handle('nightlight:steam-path-get', async (event) => {
  if (!senderIsMain(event)) return '';
  const resolved = await findSteamPath();
  return resolved || '';
});

ipcMain.handle('nightlight:steam-path-set', async (event, newPath) => {
  if (!senderIsMain(event)) return false;
  try {
    fs.mkdirSync(path.dirname(STEAM_PATH_FILE()), { recursive: true });
    fs.writeFileSync(STEAM_PATH_FILE(), String(newPath).trim(), 'utf8');
    steamPathPromise = null;
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('nightlight:window', (event, action) => {
  if (!senderIsMain(event)) return false;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'toggleMaximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  else if (action === 'close') mainWindow.close();
  else return false;
  return true;
});

ipcMain.handle('nightlight:app-info', (event) => senderIsMain(event) ? ({
  version: app.getVersion(),
  platform: process.platform,
  isDev: !app.isPackaged,
  endpoint: APP_URL,
}) : null);

ipcMain.handle('nightlight:open-external', async (event, value) => {
  if (!senderIsMain(event) || !isAllowedExternalUrl(value)) return false;
  await shell.openExternal(value);
  return true;
});

ipcMain.handle('nightlight:retry-connection', (event) => senderIsMain(event) && retryConnection());

ipcMain.handle('nightlight:steam-open', async (event) => {
  if (!senderIsMain(event)) return false;
  const steamPath = await findSteamPath();
  try {
    if (steamPath && fs.existsSync(path.join(steamPath, 'steam.exe'))) {
      startDetached(path.join(steamPath, 'steam.exe'), [], steamPath);
    } else {
      await shell.openExternal('steam://open/main');
    }
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('nightlight:windows-security-exclusions', async (event) => {
  if (!senderIsMain(event) || process.platform !== 'win32') return false;
  try {
    await shell.openExternal('windowsdefender://threatsettings');
    return true;
  } catch {
    try {
      startDetached('explorer.exe', ['windowsdefender://threatsettings'], process.env.SystemRoot || 'C:\\Windows');
      return true;
    } catch {
      return false;
    }
  }
});

ipcMain.handle('nightlight:machine-guid', async (event) => {
  if (!senderIsMain(event)) return '';
  return getMachineGuid();
});

ipcMain.handle('nightlight:steam-info', async (event) => senderIsMain(event) ? ({
  steamPath: await findSteamPath(),
  libraries: await steamLibraries(),
}) : null);

ipcMain.handle('nightlight:detect-game', async (event, appId, executable) => {
  if (!senderIsMain(event)) return null;
  return detectGameInstall(appId, executable);
});

ipcMain.handle('nightlight:select-folder', async (event) => {
  if (!senderIsMain(event)) return '';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the game installation folder',
    properties: ['openDirectory'],
  });
  return result.canceled ? '' : (result.filePaths[0] || '');
});

ipcMain.handle('nightlight:validate-folder', (event, folder, executable) => {
  if (!senderIsMain(event) || !validText(folder, 500)) {
    return { ok: false, exists: false, reason: 'invalid_input' };
  }

  if (!fs.existsSync(folder)) {
    return { ok: false, exists: false, reason: 'folder_missing' };
  }

  const raw = typeof executable === 'string'
    ? executable.trim().replace(/[\\/]+/g, path.sep)
    : '';
  if (!raw) {
    return { ok: true, exists: true, executable: '', reason: 'no_exe_configured' };
  }

  const baseName = path.basename(raw);
  const fullPath = path.join(folder, raw);
  const basePath = path.join(folder, baseName);

  // 1. Exact relative path match (e.g. "Binaries/Win64/Game.exe")
  if (fs.existsSync(fullPath)) {
    return { ok: true, exists: true, found: fullPath, reason: 'full_match' };
  }

  // 2. Just the basename in the root folder
  if (baseName && fs.existsSync(basePath)) {
    return { ok: true, exists: true, found: basePath, reason: 'basename_match' };
  }

  // 3. Recursive search up to 4 levels deep (case-insensitive on Windows)
  const needle = baseName.toLowerCase();
  const searched = [];
  let found = null;

  const search = (dir, depth) => {
    if (found || depth > 4) return;
    searched.push(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        search(full, depth + 1);
      } else if (entry.name.toLowerCase() === needle) {
        found = full;
        return;
      }
    }
  };
  search(folder, 0);

  if (found) {
    return { ok: true, exists: true, found, reason: 'recursive_match' };
  }

  console.warn(`[validate-folder] "${needle}" not found under "${folder}". Searched:`, searched.slice(0, 20));
  return { ok: false, exists: true, reason: 'not_found', needle, searchedCount: searched.length };
});

ipcMain.handle('nightlight:locations-get', (event) => senderIsMain(event) ? loadLocations() : {});
ipcMain.handle('nightlight:location-set', (event, appId, folder) => {
  if (!senderIsMain(event) || !String(appId || '').slice(0, 20) || !validText(folder, 500)) return false;
  return saveLocation(String(appId).slice(0, 20), folder);
});
ipcMain.handle('nightlight:launch-game', (event, options) => {
  if (!senderIsMain(event)) return { ok: false, error: 'Unauthorized request.' };
  return launchGame(options);
});

// ============================================================
// WINDOWS DEFENDER EXCLUSIONS — UAC flow + nl.winexc marker
// ============================================================

ipcMain.handle('open-folder', async (event, folderPath) => {
  if (!senderIsMain(event)) return false;
  if (typeof folderPath !== 'string' || !folderPath) return false;
  try {
    const err = await shell.openPath(folderPath);
    return !err; // shell.openPath returns '' on success, error string on failure
  } catch {
    return false;
  }
});

ipcMain.handle('nightlight:get-windows-exclusion-status', (event, folderPath) => {
  if (!senderIsMain(event)) return { exists: false, isAdmin: false };
  if (process.platform !== 'win32') return { exists: false, isAdmin: false };
  if (!validText(folderPath, 500)) return { exists: false, isAdmin: false };

  const exists = hasExclusionMarker(folderPath);
  return { exists, isAdmin: true };
});

ipcMain.handle('nightlight:add-windows-exclusion', async (event, folderPath) => {
  if (!senderIsMain(event)) return { ok: false, error: 'unauthorized' };
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported' };
  if (!validText(folderPath, 500)) return { ok: false, error: 'invalid_folder' };

  if (!fs.existsSync(folderPath)) {
    return { ok: false, error: 'folder_not_found' };
  }

  const escaped = folderPath.replace(/'/g, "''");
  const script = `Add-MpPreference -ExclusionPath '${escaped}'`;

  const result = await runElevatedPowerShell(script);
  if (!result.ok) return result;

  // Only write the marker AFTER the exclusion was actually added.
  const markerWritten = writeExclusionMarker(folderPath);
  return { ok: true, marker: markerWritten };
});

ipcMain.handle('nightlight:remove-windows-exclusion', async (event, folderPath) => {
  if (!senderIsMain(event)) return { ok: false, error: 'unauthorized' };
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported' };
  if (!validText(folderPath, 500)) return { ok: false, error: 'invalid_folder' };

  const escaped = folderPath.replace(/'/g, "''");
  // SilentlyContinue so we don't error if the path isn't in Defender's list
  const script = `Remove-MpPreference -ExclusionPath '${escaped}' -ErrorAction SilentlyContinue`;

  const result = await runElevatedPowerShell(script);
  if (!result.ok) return result;

  removeExclusionMarker(folderPath);
  return { ok: true };
});

// ============================================================
// Steam login / zip handling / file helpers
// ============================================================
const { checkAccount } = require('./steamChecker.js');

ipcMain.handle('nightlight:try-steam-login', async (event, username, password) => {
  if (!senderIsMain(event)) return { status: 'error', message: 'Unauthorized' };
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return { status: 'error', message: 'Invalid credentials' };
  }
  try {
    const result = await checkAccount(username, password);
    return { status: result.status, message: result.message || '' };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
});

ipcMain.handle('nightlight:steam-login-account', async (event, username, password) => {
  if (!senderIsMain(event)) return { ok: false, error: 'Unauthorized' };
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return { ok: false, error: 'Invalid credentials' };
  }
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      execFile('taskkill', ['/F', '/IM', 'steam.exe'], { windowsHide: true, timeout: 10000 }, () => resolve());
    });
    await new Promise(r => setTimeout(r, 2000));
  }
  const steamPath = await findSteamPath();
  if (!steamPath) {
    return { ok: false, error: 'Could not locate Steam installation.' };
  }
  const steamExe = path.join(steamPath, 'steam.exe');
  try {
    startDetached(steamExe, ['-login', username, password], steamPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function writeFileWithRetry(destPath, data, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      if (fs.existsSync(destPath)) {
        try { fs.chmodSync(destPath, 0o666); } catch (e) {}
        try { fs.unlinkSync(destPath); } catch (e) {}
      }
      fs.writeFileSync(destPath, data, { flag: 'w' });
      return;
    } catch (error) {
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * attempt));
    }
  }
}

ipcMain.handle('nightlight:file-exists', (event, filePath) => {
  if (!senderIsMain(event)) return false;
  try { return fs.existsSync(filePath); } catch { return false; }
});

async function handleZipDownloadAndExtract(event, url, folder, password, progressId) {
  if (!senderIsMain(event)) return { ok: false, error: 'Unauthorized' };
  if (!validText(folder, 500)) return { ok: false, error: 'Invalid folder' };

  if (!password) {
    try {
      const urlObj = new URL(url);
      const basename = path.basename(urlObj.pathname);
      if (basename.toLowerCase().endsWith('.zip')) password = basename.slice(0, -4);
    } catch { }
  }

  const sendProgress = (percent, downloaded, total) => {
    if (progressId && event.sender && !event.sender.isDestroyed()) {
      event.sender.send(`nightlight:download-progress-${progressId}`, { percent, downloaded, total });
    }
  };

  try {
    const fsExtra = require('fs-extra');
    const StreamZip = require('node-stream-zip');
    const temp = require('temp').track();

    const tempFile = temp.path({ suffix: '.zip' });
    const fileStream = fs.createWriteStream(tempFile);

    const response = await new Promise((resolve, reject) => {
      const proto = url.startsWith('https') ? require('https') : require('http');
      let redirectCount = 0;
      const handleResponse = (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          if (redirectCount >= 5) return reject(new Error('Too many redirects'));
          redirectCount++;
          const redirectUrl = new URL(resp.headers.location, url).toString();
          proto.get(redirectUrl, handleResponse).on('error', reject);
          return;
        }
        if (resp.statusCode !== 200) return reject(new Error(`Download failed with status ${resp.statusCode}`));
        resolve(resp);
      };
      proto.get(url, handleResponse).on('error', reject);
    });

    const totalSize = parseInt(response.headers['content-length'] || '0', 10);
    let downloadedSize = 0;

    response.on('data', (chunk) => {
      downloadedSize += chunk.length;
      fileStream.write(chunk);
      if (totalSize > 0) {
        const percent = Math.min(100, Math.round((downloadedSize / totalSize) * 100));
        sendProgress(percent, downloadedSize, totalSize);
      } else {
        sendProgress(-1, downloadedSize, 0);
      }
    });

    await new Promise((resolve, reject) => {
      response.on('end', resolve);
      response.on('error', reject);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    fileStream.close();
    sendProgress(100, totalSize || downloadedSize, totalSize || downloadedSize);

    let zip, entries;
    try {
      zip = new StreamZip.async({ file: tempFile, password: password || undefined });
      entries = await zip.entries();
    } catch (err) {
      if (password) {
        await zip?.close();
        zip = new StreamZip.async({ file: tempFile });
        entries = await zip.entries();
      } else throw err;
    }

    await fsExtra.ensureDir(folder);
    let extractedCount = 0, errorCount = 0, lastError = null;

    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) continue;
      const destPath = path.join(folder, entry.name);
      try {
        const data = await zip.entryData(entry);
        if (fs.existsSync(destPath)) {
          try { fs.renameSync(destPath, destPath + '.backup'); }
          catch (e) { try { fs.copyFileSync(destPath, destPath + '.backup'); } catch(err) {} }
        }
        await writeFileWithRetry(destPath, data);
        extractedCount++;
      } catch (error) {
        errorCount++;
        lastError = error;
        console.error(`Failed to extract ${entry.name}: ${error.message}`);
      }
    }

    await zip.close();
    await fsExtra.unlink(tempFile);

    if (errorCount > 0 && extractedCount === 0) {
      return { ok: false, error: `All files failed to extract. Last error: ${lastError?.message}` };
    }

    try { await fsExtra.writeFile(path.join(folder, 'nl.bypass'), ''); }
    catch (e) { console.error('Could not write marker file:', e.message); }

    return {
      ok: true,
      warning: errorCount > 0 ? `${errorCount} file(s) could not be extracted (${lastError?.message})` : undefined
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('nightlight:download-extract-zip', (event, url, folder, password) => {
  return handleZipDownloadAndExtract(event, url, folder, password, null);
});

ipcMain.handle('nightlight:download-extract-zip-progress', (event, url, folder, password, progressId) => {
  return handleZipDownloadAndExtract(event, url, folder, password, progressId);
});

ipcMain.handle('nightlight:check-steam-tool', (event, steamPath) => {
  if (!senderIsMain(event) || typeof steamPath !== 'string') return { installed: false, version: 'Unknown' };
  try {
    const dllPath = path.join(steamPath, 'OpenSteamTool.dll');
    const verPath = path.join(steamPath, 'st_version.txt');
    const installed = fs.existsSync(dllPath);
    let version = 'Unknown';
    if (fs.existsSync(verPath)) version = fs.readFileSync(verPath, 'utf8').trim();
    return { installed, version };
  } catch(e) { return { installed: false, version: 'Unknown' }; }
});

ipcMain.handle('nightlight:write-file', async (event, destPath, content) => {
  if (!senderIsMain(event) || typeof destPath !== 'string') return false;
  try { await writeFileWithRetry(destPath, content); return true; }
  catch (e) { return false; }
});

ipcMain.handle('nightlight:write-lua', async (event, steamPath, appId, content) => {
  if (!senderIsMain(event) || typeof steamPath !== 'string') return false;
  try {
    const luaDir = path.join(steamPath, 'config', 'lua');
    const target = path.join(luaDir, `${appId}.lua`);
    await writeFileWithRetry(target, content);
    return true;
  } catch (e) { return false; }
});

// ============================================================
// IN-APP KEY WINDOW
// ============================================================
ipcMain.handle('nightlight:open-key-window', async (event) => {
  if (!senderIsMain(event)) return false;
  try {
    if (keyWindow && !keyWindow.isDestroyed()) {
      if (keyWindow.isMinimized()) keyWindow.restore();
      keyWindow.focus();
      return true;
    }

    const keySession = session.fromPartition('persist:nightlight-key');

    keyWindow = new BrowserWindow({
      width: 960,
      height: 880,
      minWidth: 720,
      minHeight: 620,
      parent: mainWindow || undefined,
      backgroundColor: '#0b061a',
      autoHideMenuBar: true,
      title: 'Get Access Key — Nightlight',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-key.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        devTools: !app.isPackaged,
        spellcheck: false,
        session: keySession,
        partition: 'persist:nightlight-key',
        webSecurity: true,
      },
    });

    keyWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });

    keyWindow.on('closed', () => { keyWindow = null; });

    const machineGuid = await getMachineGuid();
    const url = `https://nl.onajlikezz.xyz/key/?in_app=1&machine=${encodeURIComponent(machineGuid || '')}&_=${Date.now()}`;

    keyWindow.loadURL(url).catch((err) => {
      console.error('Key window failed to load:', err);
      if (keyWindow && !keyWindow.isDestroyed()) {
        keyWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
          <html><body style="background:#0b061a;color:#e9d5ff;font-family:system-ui;padding:40px;text-align:center">
            <h2>Could not open the key page</h2>
            <p style="color:#a5a0c0">${String(err && err.message || err).replace(/</g,'&lt;')}</p>
            <p style="color:#a5a0c0">Open it in your browser instead:<br>
              <a style="color:#c084fc" href="https://nl.onajlikezz.xyz/key/">https://nl.onajlikezz.xyz/key/</a>
            </p>
          </body></html>
        `)}`);
      }
    });

    return true;
  } catch (e) {
    console.error('open-key-window error:', e);
    return false;
  }
});

ipcMain.on('nightlight:key-window-return', (event, key) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win === keyWindow && !win.isDestroyed()) win.close();

  if (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length < 200 &&
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    mainWindow.webContents.send('nightlight:key-received', key);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => console.error('Nightlight main process error:', error));
process.on('unhandledRejection', (error) => console.error('Nightlight main process rejection:', error));
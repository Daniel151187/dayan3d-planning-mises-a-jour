const { app, BrowserWindow, shell, Menu, ipcMain, Tray, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { Relay, testPrinter, discover } = require('./printers');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setAppUserModelId('ch.dayan3d.planning');

let win;
let tray = null;
let quitting = false;
let updateState = { state: 'idle' };
const startHidden = process.argv.includes('--hidden');

/* ---------------- Réglages de cet ordinateur ---------------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { autostart: false, keepRunning: true, hintShown: false, printersRelay: false, printersAuto: true, printers: [] };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch (e) { /* premier lancement */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { /* ignoré */ }
}
function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.autostart, args: ['--hidden'] });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1020,
    minHeight: 660,
    backgroundColor: '#151618',
    show: !(startHidden && settings.keepRunning),
    title: 'Dayan 3D Planning',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false // les rappels doivent continuer fenêtre masquée
    }
  });
  Menu.setApplicationMenu(null);

  win.on('close', (e) => {
    if (quitting || !settings.keepRunning) return;
    e.preventDefault();
    win.hide();
    if (!settings.hintShown) {
      settings.hintShown = true;
      saveSettings();
      showNotification('Dayan 3D Planning reste actif', 'L’application continue en arrière-plan pour t’envoyer tes rappels. Clic droit sur l’icône près de l’horloge pour la quitter.');
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Les liens externes (pièces jointes, etc.) s'ouvrent dans le navigateur
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https:\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('did-finish-load', () => sendStatus(updateState));
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const liveNotifications = new Set();
function showNotification(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png') });
  liveNotifications.add(n);
  n.on('click', showWindow);
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Dayan 3D Planning');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir Dayan 3D Planning', click: showWindow },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}

/* ---------------- Imprimantes (état en direct) ---------------- */
// Ce poste lit les imprimantes du réseau local et transmet l'état à l'application (qui le partage à l'équipe).
let relay = null;
function startRelay() {
  if (relay) { relay.stop(); relay = null; }
  if (!settings.printersRelay) return;
  relay = new Relay((machineId, status) => {
    if (win && !win.isDestroyed()) win.webContents.send('printers:status', { machine_id: machineId, status });
  });
  relay.configure(settings.printers);
}
const cleanPrinters = (list) => (Array.isArray(list) ? list : []).filter((p) => p && p.machine_id && (p.type === 'bambu' || p.type === 'moonraker') && String(p.host || '').trim()).map((p) => ({
  machine_id: String(p.machine_id),
  type: p.type,
  host: String(p.host).trim(),
  port: p.port ? Number(p.port) || undefined : undefined,
  serial: p.serial ? String(p.serial).trim() : undefined,
  code: p.code ? String(p.code).trim() : undefined
}));

/* ---------------- Mises à jour automatiques ---------------- */
function sendStatus(status) {
  updateState = status;
  if (win && !win.isDestroyed()) win.webContents.send('update:status', status);
}

function readUpdateUrl() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'updates.json'), 'utf8'));
    const url = String(cfg.url || '').trim();
    if (!/^https:\/\//.test(url) || /VOTRE-COMPTE/i.test(url)) return null;
    return url.endsWith('/') ? url : url + '/';
  } catch (e) {
    return null;
  }
}

let updatesReady = false;
function setupUpdates() {
  if (!app.isPackaged) { sendStatus({ state: 'dev' }); return; }
  const url = readUpdateUrl();
  if (!url) { sendStatus({ state: 'disabled' }); return; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'generic', url });

  autoUpdater.on('checking-for-update', () => sendStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => sendStatus({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => sendStatus({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => sendStatus({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => sendStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => sendStatus({ state: 'error', message: String(err && err.message ? err.message : err).slice(0, 200) }));

  updatesReady = true;
  checkUpdates();
  setInterval(checkUpdates, 4 * 60 * 60 * 1000);
}

function checkUpdates() {
  if (!updatesReady) return;
  if (updateState.state === 'downloading' || updateState.state === 'ready') return;
  autoUpdater.checkForUpdates().catch(() => {});
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:show', () => { showWindow(); });
ipcMain.handle('notify', (_e, { title, body }) => { showNotification(String(title || ''), String(body || '')); });
ipcMain.handle('printers:get', () => ({ relay: !!settings.printersRelay, auto: settings.printersAuto !== false, printers: settings.printers || [] }));
ipcMain.handle('printers:set', (_e, cfg) => {
  settings.printersRelay = !!(cfg && cfg.relay);
  settings.printersAuto = !(cfg && cfg.auto === false);
  settings.printers = cleanPrinters(cfg && cfg.printers);
  saveSettings();
  startRelay();
  return { relay: settings.printersRelay, auto: settings.printersAuto, printers: settings.printers };
});
ipcMain.handle('printers:discover', async () => {
  try { return await discover(); } catch (e) { return { error: String(e && e.message ? e.message : e), bambu: [], moonraker: [], networks: [] }; }
});
ipcMain.handle('printers:test', (_e, cfg) => testPrinter(cleanPrinters([{ ...cfg, machine_id: 'test' }])[0] || cfg));
ipcMain.handle('settings:get', () => ({ ...settings, packaged: app.isPackaged }));
ipcMain.handle('settings:set', (_e, patch) => {
  if (patch && typeof patch.autostart === 'boolean') settings.autostart = patch.autostart;
  if (patch && typeof patch.keepRunning === 'boolean') settings.keepRunning = patch.keepRunning;
  saveSettings();
  applyAutostart();
  return { ...settings, packaged: app.isPackaged };
});
ipcMain.handle('update:check', () => { checkUpdates(); return updateState; });
ipcMain.handle('update:install', () => {
  if (updateState.state === 'ready') { quitting = true; autoUpdater.quitAndInstall(false, true); }
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(() => {
  loadSettings();
  applyAutostart();
  createWindow();
  createTray();
  setupUpdates();
  startRelay();
});
app.on('window-all-closed', () => app.quit());

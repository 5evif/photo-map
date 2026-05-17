/*
 * main.js — The Main Process (Background Worker)
 *
 * This file runs invisibly in the background. It is responsible for:
 *   - Creating the app window you see on screen
 *   - Reading and writing files on your hard drive
 *   - Scanning folders for photos and extracting GPS data
 *   - Generating thumbnail images for HEIC/HEIF photos
 *   - Renaming photo files when you ask it to
 *   - Watching your photo folder for new or deleted photos
 *   - Saving and loading app settings (API key, folder path, etc.)
 *   - Reading and writing "photo-map-data.json" — a metadata file that
 *     lives in the same folder as your photos and stores notes, bad-GPS
 *     flags, pin colors, and map labels so the data travels with the photos.
 *   - Managing a lock file ("photo-map-data.lock") that prevents two people
 *     from editing the same photo folder's annotations at the same time.
 *   - Exporting photos and annotations to GeoJSON (for GIS tools) and CSV
 *     (for spreadsheets) when the user requests it from Settings.
 *   - Sending live scan-progress events to the window so the status bar
 *     shows how many files have been processed during a large folder scan.
 *
 * It talks to the visible window (the "renderer process") through a
 * secure messaging system called IPC (Inter-Process Communication).
 *
 * Files it talks to:
 *   - src/preload/preload.js  (the secure bridge between this file and the window)
 *   - src/renderer/index.html (the visible window content)
 *
 * =============================================================
 * IPC CHANNEL INDEX — Messages this file sends and receives
 * =============================================================
 *
 * RECEIVES from the renderer (window):
 *   "get-settings"          — Window asks for stored app settings on startup.
 *   "save-settings"         — Window sends updated settings to save to disk.
 *   "pick-folder"           — Window asks us to show the OS folder-picker dialog.
 *   "scan-folder"           — Window asks us to scan the photo folder for GPS data.
 *   "get-thumbnail"         — Window asks for a thumbnail image for a specific photo.
 *   "rename-file"           — Window asks us to rename a photo file on disk.
 *   "show-in-folder"        — Window asks us to reveal a file in Finder/Explorer.
 *   "clear-thumbnail-cache" — Window asks us to delete all cached thumbnail files.
 *   "watch-folder"          — Window asks us to start watching the folder for changes.
 *   "stop-watching"         — Window asks us to stop watching the folder.
 *   "read-metadata"         — Window asks us to read photo-map-data.json.
 *   "write-metadata"        — Window sends full metadata to save to photo-map-data.json.
 *   "acquire-lock"          — Window asks us to create the lock file for the folder.
 *   "release-lock"          — Window asks us to delete the lock file.
 *   "check-lock"            — Window asks whether the folder is locked by someone else.
 *   "read-readme"           — Window asks us to read the README.md file bundled with the app.
 *   "export-data"           — Window asks us to export photos + annotations to GeoJSON or CSV.
 *
 * SENDS to the renderer (window):
 *   "folder-changed"        — Sent when chokidar detects a new or deleted photo.
 *   "scan-progress"         — Sent periodically during a scan to show live progress in the status bar.
 */

'use strict';

// Surface crashes in the main process rather than silently swallowing them.
process.on('uncaughtException',   (err)    => console.error('Uncaught exception in main process:',       err));
process.on('unhandledRejection',  (reason) => console.error('Unhandled rejection in main process:',      reason));

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
// Remove the default Electron menu bar entirely.
Menu.setApplicationMenu(null);
const { Worker } = require('worker_threads'); // built into Node.js — runs thumbnail generation off the main thread
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const os     = require('os');     // built into Node.js — used for the machine hostname in lock files
const crypto = require('crypto'); // built into Node.js — used to hash thumbnail filenames
const Store  = require('electron-store');
const chokidar = require('chokidar');
const exifr    = require('exifr');  // reads GPS and date from photo EXIF metadata
const { isPidRunning, csvEscape, SUPPORTED_EXTENSIONS } = require('../utils.js');

// ─── App-wide state ────────────────────────────────────────────────────────────

// electron-store saves user preferences to a JSON file in the OS app-data folder.
// (e.g. ~/Library/Application Support/photo-map/ on macOS)
const store = new Store({
  defaults: {
    apiKey:       '',
    folderPath:   '',
    recursive:    true,
    windowBounds: { width: 1280, height: 860 },
    sidebarWidth: 340,       // Last-used sidebar width, in pixels
    pinColor:     '#4f8ef7'  // Default photo-pin color
  }
});

const THUMBNAIL_CACHE_DIR      = path.join(app.getPath('userData'), 'thumbnails');
const GPS_CACHE_FILE           = path.join(app.getPath('userData'), 'gps-cache.json');
const THUMBNAIL_CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB — evict oldest thumbnails beyond this

// This file lives inside the user's photo folder so data travels with the photos.
const METADATA_FILENAME = 'photo-map-data.json';

// The lock file sits next to the metadata file. Its presence means someone else
// currently has this folder open and is editing annotations. We create it when
// we open a folder and delete it when we close the app or switch folders.
const LOCK_FILENAME = 'photo-map-data.lock';

// Track which folder we currently hold a lock on so we can release it cleanly.
let currentLockFolder = null;

// UUID written into the lock file we currently hold.  Used instead of PID as
// the primary identity so settings reloads are recognised as the same session
// and so we never accidentally release another instance's lock.
let sessionLockUUID = null;

let folderWatcher = null;  // chokidar watcher instance
let mainWindow    = null;  // the BrowserWindow

// ─── Startup ───────────────────────────────────────────────────────────────────

function ensureCacheDirExists() {
  if (!fs.existsSync(THUMBNAIL_CACHE_DIR)) {
    fs.mkdirSync(THUMBNAIL_CACHE_DIR, { recursive: true });
  }
}

function createWindow() {
  const raw    = store.get('windowBounds');
  const width  = Number.isInteger(raw?.width)  && raw.width  >= 400 ? raw.width  : 1280;
  const height = Number.isInteger(raw?.height) && raw.height >= 300 ? raw.height : 860;

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth:  900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Sandboxes the renderer process so it cannot access Node.js APIs
      // directly. The preload still works because it only uses contextBridge
      // and ipcRenderer, both of which are available in sandboxed preloads.
      sandbox: true
    },
    // 'hiddenInset' overlays the traffic-light buttons on the toolbar on macOS.
    // On Windows the default title bar is used instead (buttons on the right).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist-renderer', 'index.html'));

  // Redirect any navigation away from the local app file to the system browser.
  // Without this, clicking an <a href="https://..."> in the renderer replaces the
  // app window with the website and there is no way back without restarting.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Also handle target="_blank" links (e.g. the map attribution anchors).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('file://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Save window size whenever the user resizes it.
  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    store.set('windowBounds', { width, height });
  });

}

// ─── GPS Cache ─────────────────────────────────────────────────────────────────

function loadGpsCache() {
  try {
    if (fs.existsSync(GPS_CACHE_FILE))
      return JSON.parse(fs.readFileSync(GPS_CACHE_FILE, 'utf8'));
  } catch (err) { console.error('GPS cache unreadable, starting fresh:', err.message); }
  return {};
}

function saveGpsCache(cache) {
  try { fs.writeFileSync(GPS_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); }
  catch (err) { console.error('Could not save GPS cache:', err.message); }
}

// ─── Per-Folder Metadata File ──────────────────────────────────────────────────

/*
 * Returns the full path to the metadata file inside the photo folder.
 * Example: "/Users/sara/Trips/photo-map-data.json"
 */
function metadataFilePath(folderPath) {
  return path.join(folderPath, METADATA_FILENAME);
}

/*
 * Reads the metadata file from the given photo folder.
 * Returns a fresh empty object if the file doesn't exist yet.
 *
 * The metadata shape is:
 * {
 *   version: 1,
 *   pinColor: "#4f8ef7",      ← global default pin color
 *   labels: [ { id, lat, lng, text, size }, … ],
 *   photos: {
 *     "/full/path/to/photo.jpg": {
 *       note:     "string or empty",
 *       badGps:   true/false,
 *       pinColor: "#rrggbb or null to use global"
 *     },
 *     …
 *   }
 * }
 */
function readMetadata(folderPath) {
  try {
    const fp = metadataFilePath(folderPath);
    if (fs.existsSync(fp))
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (err) { console.error('Could not read metadata:', err.message); }
  return { version: 1, pinColor: '#4f8ef7', labels: [], photos: {} };
}

/*
 * Writes the metadata object to photo-map-data.json in the photo folder.
 * Input: folderPath — the photo folder
 *        metadata   — the complete metadata object to save
 * Returns: { success: true } or { success: false, error }
 */
function writeMetadata(folderPath, metadata) {
  try {
    fs.writeFileSync(metadataFilePath(folderPath), JSON.stringify(metadata, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Lock File Management ─────────────────────────────────────────────────────
//
// We use a plain JSON file ("photo-map-data.lock") as a cooperative lock.
// When Photo Map opens a folder it writes this file with the current user's
// name, machine name, and a timestamp.  Before opening, it checks whether
// the file already exists and reports back to the renderer so it can block
// access and show a clear error message.
//
// Limitations: this is a cooperative lock, not a filesystem-level exclusive
// lock.  It protects against two people running the app at the same time on
// shared network storage.  It does not protect against someone deleting the
// lock file manually, but that is an intentional escape hatch for stuck locks.

/*
 * Returns the full path to the lock file for the given photo folder.
 * Example: "/Volumes/Server/Photos/photo-map-data.lock"
 */
function lockFilePath(folderPath) {
  return path.join(folderPath, LOCK_FILENAME);
}

/*
 * Reads and returns the contents of the lock file, or null if none exists.
 * Returns an object like: { user, machine, pid, timestamp }
 */
function readLock(folderPath) {
  try {
    const lp = lockFilePath(folderPath);
    if (fs.existsSync(lp))
      return JSON.parse(fs.readFileSync(lp, 'utf8'));
  } catch (err) {
    console.warn('Could not read lock file:', err.message);
  }
  return null;
}

/*
 * Creates the lock file for the given folder, recording who opened it.
 *
 * Uses O_EXCL (the 'wx' flag) to atomically create the file, which eliminates
 * the TOCTOU race where two processes could both pass a "does the file exist?"
 * check and both believe they hold the lock.
 *
 * Each lock file includes a random UUID.  Within a session, sessionLockUUID
 * lets us recognise our own lock without relying solely on PID (which can be
 * reused by unrelated processes after a crash).
 *
 * Input:  folderPath — the photo folder to lock
 * Returns: { success: true }
 *       or { success: false, error: 'locked',    lockedBy: { user, machine, pid, timestamp } }
 *       or { success: false, error: 'unwritable', message: "..." }
 */
function acquireLock(folderPath) {
  const lockPath = lockFilePath(folderPath);

  // Atomically create the lock file.  Returns { success: true } on success,
  // null when EEXIST (another holder beat us), or an error object on write failure.
  function tryCreate() {
    const uuid = crypto.randomUUID();
    const data = {
      uuid,
      user:      os.userInfo().username || os.userInfo().uid?.toString() || 'unknown',
      machine:   os.hostname()          || 'unknown',
      pid:       process.pid,
      timestamp: new Date().toISOString()
    };
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx'); // fails with EEXIST if file already exists
    } catch (err) {
      if (err.code === 'EEXIST') return null;
      return { success: false, error: 'unwritable', message: err.message };
    }
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2));
      fs.closeSync(fd);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      return { success: false, error: 'unwritable', message: err.message };
    }
    sessionLockUUID   = uuid;
    currentLockFolder = folderPath;
    return { success: true };
  }

  // First attempt: try to create atomically.
  const first = tryCreate();
  if (first !== null) return first;

  // Lock file exists — read who holds it.
  const existing = readLock(folderPath);

  if (!existing) {
    // File disappeared between our open attempt and our read — retry once.
    return tryCreate() ?? { success: false, error: 'locked', lockedBy: {} };
  }

  // Same session (e.g. Settings "Save & Reload" within a running session).
  if (existing.uuid && existing.uuid === sessionLockUUID) {
    currentLockFolder = folderPath;
    return { success: true };
  }

  // Different session: check if the PID is still alive.
  if (isPidRunning(existing.pid)) {
    return { success: false, error: 'locked', lockedBy: existing };
  }

  // Stale lock (app crashed or was force-killed without cleanup) — remove and retry.
  console.warn(
    `Removing stale lock left by PID ${existing.pid} (${existing.user}@${existing.machine})`
  );
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }

  return tryCreate() ?? { success: false, error: 'locked', lockedBy: existing };
}

/*
 * Deletes the lock file for the given folder (or the currently locked folder
 * if no path is supplied).  Safe to call even if no lock exists.
 */
function releaseLock(folderPath) {
  const target = folderPath || currentLockFolder;
  if (!target) return;
  try {
    const lp = lockFilePath(target);
    if (fs.existsSync(lp)) {
      const lock = readLock(target);
      // Primary check: UUID must match our session — never steal another instance's lock.
      // Fallback: old lock files written before the UUID field was added use PID only.
      const isOurs = lock && (
        (lock.uuid && lock.uuid === sessionLockUUID) ||
        (!lock.uuid && lock.pid === process.pid)
      );
      if (isOurs) {
        fs.unlinkSync(lp);
        sessionLockUUID = null;
      }
    }
  } catch (err) {
    console.warn('Could not release lock file:', err.message);
  }
  if (target === currentLockFolder) currentLockFolder = null;
}

// ─── Folder Scanning ───────────────────────────────────────────────────────────

/*
 * Recursively collects all photo file paths from a folder.
 * Input: folderPath — full path to the folder
 *        recursive  — true to include subfolders
 * Returns: array of file-path strings
 */
async function collectPhotoFiles(folderPath, recursive) {
  const results = [];

  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (err) { console.error(`Cannot read ${dir}:`, err.message); return; }

    for (const entry of entries) {
      if (entry.name === METADATA_FILENAME) continue; // skip our own metadata file
      if (entry.name === LOCK_FILENAME) continue;     // skip our own lock file
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && recursive) { await walk(full); }
      else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  }

  await walk(folderPath);
  return results;
}

/*
 * Extracts GPS + date from a single photo using exifr.
 * Returns null if the file has no GPS data or can't be read.
 */
async function extractPhotoData(filePath) {
  try {
    const stat  = await fs.promises.stat(filePath);
    const data  = await exifr.parse(filePath, {
      pick: ['GPSLatitude','GPSLongitude','GPSLatitudeRef','GPSLongitudeRef',
             'DateTimeOriginal','CreateDate']
    });

    if (!data || data.latitude === undefined) {
      const gps = await exifr.gps(filePath).catch(() => null);
      if (!gps) {
        const date = data ? ((data.DateTimeOriginal || data.CreateDate || null)?.toISOString?.() ?? null) : null;
        return { filePath, filename: path.basename(filePath), date, noGps: true, mtimeMs: stat.mtimeMs };
      }
      return { lat: gps.latitude, lng: gps.longitude, date: null,
               filename: path.basename(filePath), filePath, mtimeMs: stat.mtimeMs };
    }

    return {
      lat: data.latitude, lng: data.longitude,
      date: (data.DateTimeOriginal || data.CreateDate || null)?.toISOString?.() ?? null,
      filename: path.basename(filePath), filePath, mtimeMs: stat.mtimeMs
    };
  } catch (err) {
    console.error(`EXIF error on ${filePath}:`, err.message);
    return null;
  }
}

/*
 * Scans the folder for photos with GPS data, using the cache to skip unchanged files.
 * Returns: { photos, totalScanned, totalWithGps, errors }
 */
async function scanFolder(folderPath, recursive) {
  const cache = loadGpsCache();
  const updatedCache = {};
  const photos      = [];
  const noGpsPhotos = [];
  const errors      = [];

  const files = await collectPhotoFiles(folderPath, recursive);
  const totalScanned = files.length;

  // Scale batch size to available CPU cores so we don't under-use multi-core
  // machines or thrash single-core ones with excessive parallelism.
  const BATCH_SIZE = Math.max(4, os.cpus().length);
  let processedCount = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    await Promise.all(files.slice(i, i + BATCH_SIZE).map(async (filePath) => {
      try {
        const stat   = await fs.promises.stat(filePath);
        const cached = cache[filePath];

        if (cached && cached.mtimeMs === stat.mtimeMs) {
          updatedCache[filePath] = cached;
          if (cached.lat !== undefined) photos.push(cached);
          else if (cached.noGps && cached.filename) noGpsPhotos.push(cached);
          return;
        }

        const data = await extractPhotoData(filePath);
        if (data && !data.noGps) {
          updatedCache[filePath] = data;
          photos.push(data);
        } else if (data && data.noGps) {
          updatedCache[filePath] = data;
          noGpsPhotos.push(data);
        } else {
          updatedCache[filePath] = { filePath, mtimeMs: stat.mtimeMs, error: true };
        }
      } catch (err) {
        errors.push({ filePath, error: err.message });
      } finally {
        // Count every file processed and send a progress update to the renderer.
        processedCount++;
        mainWindow?.webContents.send('scan-progress', {
          processed: processedCount,
          total:     totalScanned,
          withGps:   photos.length
        });
      }
    }));
  }

  // Merge: preserve cache entries from other folders; replace entries for this
  // folder with the freshly scanned results (which also drops entries for files
  // that have since been deleted from this folder).
  const folderPrefix = folderPath.endsWith(path.sep) ? folderPath : folderPath + path.sep;
  const mergedCache  = { ...cache };
  for (const fp of Object.keys(mergedCache)) {
    if (fp.startsWith(folderPrefix) && !updatedCache[fp]) delete mergedCache[fp];
  }
  Object.assign(mergedCache, updatedCache);
  saveGpsCache(mergedCache);

  return { photos, noGpsPhotos, totalScanned, totalWithGps: photos.length, errors };
}

// ─── Thumbnail Generation (worker thread) ─────────────────────────────────────

/*
 * Evicts the oldest thumbnails if the cache directory exceeds THUMBNAIL_CACHE_MAX_BYTES.
 * Called asynchronously after each successful thumbnail write — does not block
 * the caller or affect the returned thumbnail path.
 */
async function enforceThumbnailCacheSize() {
  try {
    const names   = await fs.promises.readdir(THUMBNAIL_CACHE_DIR);
    const entries = (await Promise.all(
      names.map(async n => {
        const fp = path.join(THUMBNAIL_CACHE_DIR, n);
        try { const s = await fs.promises.stat(fp); return { fp, size: s.size, mtime: s.mtimeMs }; }
        catch { return null; }
      })
    )).filter(Boolean);

    const total = entries.reduce((s, e) => s + e.size, 0);
    if (total <= THUMBNAIL_CACHE_MAX_BYTES) return;

    entries.sort((a, b) => a.mtime - b.mtime); // oldest first
    let remaining = total;
    for (const { fp, size } of entries) {
      if (remaining <= THUMBNAIL_CACHE_MAX_BYTES) break;
      await fs.promises.unlink(fp).catch(() => {});
      remaining -= size;
    }
  } catch (err) {
    console.error('Thumbnail cache eviction error:', err.message);
  }
}

/*
 * Generates (or retrieves from cache) a JPEG thumbnail for a photo.
 * The actual image processing runs in a separate worker thread so that
 * slow HEIC decoding never freezes the main process or delays the UI.
 *
 * Cache key: SHA-1 hash of the full file path → always 44 characters,
 * preventing the 255-byte filesystem filename limit on deep folder trees.
 *
 * Input:  filePath — full absolute path to the photo on disk
 * Returns: full path to the cached JPEG thumbnail, or null on failure
 */
async function getThumbnail(filePath) {
  const hash      = crypto.createHash('sha1').update(filePath).digest('hex');
  const thumbPath = path.join(THUMBNAIL_CACHE_DIR, hash + '.jpg');

  // Return cached version immediately — no worker needed.
  if (fs.existsSync(thumbPath)) return thumbPath;

  // Spawn a worker thread to generate the thumbnail.
  // Using a thread means HEIC decoding (which can take 1–3 seconds for large
  // iPhone photos) does not block any other IPC calls or UI updates.
  return new Promise((resolve) => {
    const worker = new Worker(
      path.join(__dirname, 'thumbnail-worker.js'),
      { workerData: { filePath, thumbPath } }
    );

    worker.on('message', (result) => {
      if (result.success) enforceThumbnailCacheSize(); // fire-and-forget; don't block the caller
      resolve(result.success ? result.thumbPath : null);
    });

    worker.on('error', (err) => {
      console.error(`Thumbnail worker error for ${filePath}:`, err.message);
      resolve(null);
    });

    // If the worker crashes entirely, resolve null so the UI shows gracefully.
    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Thumbnail worker exited with code ${code} for ${filePath}`);
        resolve(null);
      }
    });
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => ({
  apiKey:       store.get('apiKey'),
  folderPath:   store.get('folderPath'),
  recursive:    store.get('recursive'),
  sidebarWidth: store.get('sidebarWidth'),
  pinColor:     store.get('pinColor')
}));

ipcMain.handle('save-settings', (event, s) => {
  if (s.apiKey       !== undefined) store.set('apiKey',       s.apiKey);
  if (s.folderPath   !== undefined) store.set('folderPath',   s.folderPath);
  if (s.recursive    !== undefined) store.set('recursive',    s.recursive);
  if (s.sidebarWidth !== undefined) store.set('sidebarWidth', s.sidebarWidth);
  if (s.pinColor     !== undefined) store.set('pinColor',     s.pinColor);
  return { success: true };
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: 'Choose your photo folder'
  });
  return (result.canceled || !result.filePaths.length) ? null : result.filePaths[0];
});

ipcMain.handle('scan-folder', async (event, { folderPath, recursive }) => {
  if (!fs.existsSync(folderPath))
    return { error: 'Folder not found. Please select a different folder in Settings.' };
  return scanFolder(folderPath, recursive);
});

/*
 * Scans a single newly-added file instead of the whole folder.
 * Called by the renderer when chokidar reports a new photo so we don't
 * re-extract EXIF from every file in the folder on each add event.
 * Returns: { success, photo?, noGps? }
 */
ipcMain.handle('scan-single-file', async (event, filePath) => {
  if (typeof filePath !== 'string' || !SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    return { success: false, error: 'Invalid file path' };
  try {
    const cache  = loadGpsCache();
    const stat   = await fs.promises.stat(filePath);
    const cached = cache[filePath];

    let data;
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      data = cached;
    } else {
      data = await extractPhotoData(filePath);
      if (data) {
        cache[filePath] = data;
        saveGpsCache(cache);
      }
    }

    if (!data) return { success: false, error: 'Could not read file metadata' };
    return {
      success: true,
      photo:  !data.noGps ? data : null,
      noGps:   data.noGps ? data : null
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-thumbnail', async (event, filePath) => getThumbnail(filePath));

ipcMain.handle('rename-file', async (event, { oldPath, newName, folderPath: _folderPath }) => {
  const dir = path.dirname(oldPath);

  if (/[\/\\:*?"<>|]/.test(newName))
    return { success: false, error: 'Filename contains illegal characters (/ \\ : * ? " < > |)' };
  if (!newName.trim())
    return { success: false, error: 'Filename cannot be empty.' };

  // If the target name is already taken (and it's not a case-only rename of the
  // same file), append a Windows-style copy number: "name (2).ext", "(3)", etc.
  const ext  = path.extname(newName);
  const base = path.basename(newName, ext);
  let resolvedName = newName;
  let counter = 2;
  while (
    fs.existsSync(path.join(dir, resolvedName)) &&
    oldPath.toLowerCase() !== path.join(dir, resolvedName).toLowerCase()
  ) {
    resolvedName = `${base} (${counter})${ext}`;
    counter++;
  }

  const newPath = path.join(dir, resolvedName);

  try {
    fs.renameSync(oldPath, newPath);

    // Keep GPS cache key in sync with new path.
    const cache = loadGpsCache();
    if (cache[oldPath]) {
      cache[newPath] = { ...cache[oldPath], filePath: newPath, filename: resolvedName };
      delete cache[oldPath];
      saveGpsCache(cache);
    }

    // Metadata re-keying is handled entirely by the renderer after it receives
    // this result — it re-keys state.meta in memory then calls saveMetadata(),
    // which writes the full authoritative state to disk.  Doing it here would
    // read a potentially stale disk snapshot and could silently drop fields
    // (like gpsOverride) that the renderer holds in memory but hasn't yet flushed.

    return { success: true, newPath, newName: resolvedName };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('show-in-folder', (event, filePath) => shell.showItemInFolder(filePath));

// Makes a HEAD request to a URL from the main process (no CORS restrictions)
// and returns the HTTP status code.  Used by the renderer to distinguish
// "bad API key" (401/403) from "quota exceeded" (429) tile errors.
ipcMain.handle('check-tile-status', (event, url) => {
  // Use the URL constructor (not a regex) to parse the URL — this is immune to
  // bypass tricks like embedded credentials or Unicode homoglyphs.
  let parsed;
  try { parsed = new URL(url); } catch { return { status: 0 }; }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.maptiler.com'))
    return { status: 0 };
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      resolve({ status: res.statusCode });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0 }); });
    req.end();
  });
});

ipcMain.handle('clear-thumbnail-cache', async () => {
  try {
    const files = await fs.promises.readdir(THUMBNAIL_CACHE_DIR);
    await Promise.all(files.map(f => fs.promises.unlink(path.join(THUMBNAIL_CACHE_DIR, f))));
    return { success: true, count: files.length };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('watch-folder', (event, { folderPath, recursive }) => {
  if (folderWatcher) { folderWatcher.close(); folderWatcher = null; }

  folderWatcher = chokidar.watch(
    recursive ? path.join(folderPath, '**') : path.join(folderPath, '*'),
    {
      ignored: [
        /(^|[\/\\])\./,                      // dotfiles
        `**/${METADATA_FILENAME}`,
        `**/${LOCK_FILENAME}`,
        (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
      ],
      persistent: true, ignoreInitial: true
    }
  );

  folderWatcher.on('add', (fp) => {
    if (SUPPORTED_EXTENSIONS.has(path.extname(fp).toLowerCase()))
      mainWindow?.webContents.send('folder-changed', { type: 'add', filePath: fp });
  });
  folderWatcher.on('unlink', (fp) => {
    if (SUPPORTED_EXTENSIONS.has(path.extname(fp).toLowerCase()))
      mainWindow?.webContents.send('folder-changed', { type: 'remove', filePath: fp });
  });

  return { success: true };
});

ipcMain.handle('stop-watching', () => {
  if (folderWatcher) { folderWatcher.close(); folderWatcher = null; }
  return { success: true };
});

/*
 * Reads photo-map-data.json from the given photo folder.
 * Input: folderPath string
 * Returns: metadata object (never null — returns empty structure if file missing)
 */
ipcMain.handle('read-metadata', (event, folderPath) => readMetadata(folderPath));

/*
 * Saves the full metadata object to photo-map-data.json inside the photo folder.
 * Input: { folderPath, metadata }
 * Returns: { success: true } or { success: false, error }
 */
ipcMain.handle('write-metadata', (event, { folderPath, metadata }) =>
  writeMetadata(folderPath, metadata)
);

/*
 * Responds to "acquire-lock" — tries to claim the lock file for a folder.
 * Input:  folderPath string
 * Returns: { success: true }
 *       or { success: false, error: 'locked', lockedBy: { user, machine, timestamp } }
 *       or { success: false, error: 'unwritable', message: "..." }
 */
ipcMain.handle('acquire-lock', (event, folderPath) => acquireLock(folderPath));

/*
 * Responds to "release-lock" — deletes the lock file for a folder.
 * Input:  folderPath string (optional — defaults to currently locked folder)
 */
ipcMain.handle('release-lock', (event, folderPath) => {
  releaseLock(folderPath);
  return { success: true };
});

/*
 * Responds to "check-lock" — reads the lock file without modifying it.
 * Useful for showing a "retry" prompt after a lock error.
 * Input:  folderPath string
 * Returns: { locked: false } or { locked: true, lockedBy: { user, machine, timestamp } }
 */
ipcMain.handle('check-lock', (event, folderPath) => {
  const lock = readLock(folderPath);
  if (!lock) return { locked: false };
  if (lock.pid === process.pid) return { locked: false }; // our own lock
  return { locked: true, lockedBy: lock };
});

/*
 * Responds to "read-readme" — reads the README.md file and returns its text.
 *
 * In development the README lives at the project root (one level above src/).
 * In a packaged app electron-builder copies it into the app's resource bundle.
 * We try both locations so the feature works in both modes.
 *
 * Returns: the full README text as a string, or an error message.
 */
ipcMain.handle('read-readme', () => {
  // Candidate paths — try them in order.
  const candidates = [
    path.join(__dirname, '..', '..', 'README.md'),          // dev: src/main/ → project root
    path.join(process.resourcesPath || '', 'README.md'),     // packaged: resources/README.md
    path.join(app.getAppPath(), 'README.md')                 // packaged alternative
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { success: true, text: fs.readFileSync(candidate, 'utf8') };
      }
    } catch (err) {
      console.warn(`Could not read README at ${candidate}:`, err.message);
    }
  }

  return { success: false, error: 'README.md not found.' };
});

/*
 * Responds to "export-data" — exports all GPS photos and their annotations
 * to either a GeoJSON file or a CSV file that the user selects via a save dialog.
 *
 * GeoJSON is a standard format understood by QGIS, ArcGIS, Mapbox, and
 * most other GIS tools.  Each photo becomes a GeoJSON Feature with its
 * coordinates as geometry and its annotations as properties.
 *
 * CSV exports one row per photo with columns for filename, latitude, longitude,
 * date taken, note, and bad-GPS flag.  Opens directly in Excel or Google Sheets.
 *
 * Input:  { photos, metadata, format }
 *   photos   — array of { filePath, filename, lat, lng, date }
 *   metadata — the photo-map-data.json metadata object (for notes/flags)
 *   format   — "geojson" or "csv"
 */
ipcMain.handle('export-data', async (event, { photos, metadata, format }) => {
  const isGeoJson = format === 'geojson';

  const result = await dialog.showSaveDialog(mainWindow, {
    title:       isGeoJson ? 'Export GeoJSON' : 'Export CSV',
    defaultPath: isGeoJson ? 'photo-map-export.geojson' : 'photo-map-export.csv',
    filters:     isGeoJson
      ? [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }]
      : [{ name: 'CSV',     extensions: ['csv'] }]
  });

  if (result.canceled) return { success: false, error: 'Cancelled' };

  try {
    let output = '';

    if (isGeoJson) {
      // Build a GeoJSON FeatureCollection — each photo is a Point feature.
      const features = photos.map(p => {
        const pm = (metadata.photos || {})[p.filePath] || {};
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, // GeoJSON is [lng, lat]
          properties: {
            filename: p.filename,
            filePath: p.filePath,
            date:     p.date || null,
            note:     pm.note     || '',
            badGps:   pm.badGps   || false,
            pinColor: pm.pinColor || null
          }
        };
      });
      output = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);

    } else {
      // Build a CSV.
      const header = ['filename', 'latitude', 'longitude', 'date', 'note', 'bad_gps'];
      const rows   = photos.map(p => {
        const pm = (metadata.photos || {})[p.filePath] || {};
        return [
          csvEscape(p.filename),
          p.lat,
          p.lng,
          csvEscape(p.date || ''),
          csvEscape(pm.note || ''),
          pm.badGps ? 'true' : 'false'
        ].join(',');
      });
      output = [header.join(','), ...rows].join('\n');
    }

    fs.writeFileSync(result.filePath, output, 'utf8');
    return { success: true, count: photos.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.whenReady().then(() => {
  ensureCacheDirExists();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (folderWatcher) folderWatcher.close();
  // Always release the lock when the app exits, even if it crashes or is
  // force-quit. This runs synchronously so the file is deleted before exit.
  releaseLock();
});

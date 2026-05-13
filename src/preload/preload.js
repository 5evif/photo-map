/*
 * preload.js — The Secure Bridge
 *
 * This file runs in a special in-between zone: it has access to both
 * the Node.js world (main process) and the browser world (renderer).
 * Its job is to expose a safe, controlled set of functions to the window
 * via window.photoMap, so the renderer can request actions from main.js
 * without having unrestricted access to the filesystem.
 *
 * Files it talks to:
 *   - src/main/main.js       (sends/receives IPC messages)
 *   - src/renderer/renderer.js  (window.photoMap is used here)
 *
 * =============================================================
 * IPC CHANNEL INDEX
 * =============================================================
 *
 * "get-settings"          — Fetch stored app settings (API key, folder, sidebar width, pin color).
 * "save-settings"         — Persist updated settings to disk.
 * "pick-folder"           — Open the OS folder-picker dialog; returns the chosen path.
 * "scan-folder"           — Scan the photo folder; returns GPS data array.
 * "get-thumbnail"         — Generate/retrieve a cached thumbnail; returns path.
 * "rename-file"           — Rename a file on disk.
 * "show-in-folder"        — Reveal a file in Finder / Explorer.
 * "clear-thumbnail-cache" — Delete all cached thumbnail files.
 * "watch-folder"          — Start watching a folder for changes.
 * "stop-watching"         — Stop watching.
 * "read-metadata"         — Read photo-map-data.json from the photo folder.
 * "write-metadata"        — Write photo-map-data.json to the photo folder.
 * "acquire-lock"          — Create the lock file for the photo folder, or report who holds it.
 * "release-lock"          — Delete the lock file when leaving a folder or closing the app.
 * "check-lock"            — Read the current lock state without changing it.
 *                            Available for retry flows; currently the retry button
 *                            re-calls acquireLock directly instead.
 * "read-readme"           — Read the README.md file bundled with the app.
 * "export-data"           — Export photos + annotations to GeoJSON or CSV.
 *
 * EVENTS RECEIVED FROM MAIN:
 * "folder-changed"        — A photo was added or deleted; { type, filePath }.
 * "open-settings"         — User clicked Settings in the menu bar.
 * "scan-progress"         — Sent during folder scan; { processed, total, withGps }.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photoMap', {

  // ── App Settings ─────────────────────────────────────────────────────────────

  /** Fetches all stored settings: { apiKey, folderPath, recursive, sidebarWidth, pinColor } */
  getSettings: () => ipcRenderer.invoke('get-settings'),

  /** Saves any subset of settings to disk. */
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ── Folder Picking & Scanning ─────────────────────────────────────────────────

  /** Opens the OS folder-picker dialog. Returns chosen path, or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  /**
   * Scans folderPath for photos with GPS data.
   * Input:   { folderPath, recursive }
   * Returns: { photos, totalScanned, totalWithGps, errors }
   */
  scanFolder: (opts) => ipcRenderer.invoke('scan-folder', opts),

  // ── Thumbnails ────────────────────────────────────────────────────────────────

  /**
   * Gets a JPEG thumbnail path for the given photo (generates it if needed).
   * Input:   filePath string
   * Returns: thumbnail path string, or null
   */
  getThumbnail: (filePath) => ipcRenderer.invoke('get-thumbnail', filePath),

  /** Delete all cached thumbnails to free up disk space. */
  clearThumbnailCache: () => ipcRenderer.invoke('clear-thumbnail-cache'),

  // ── File Operations ───────────────────────────────────────────────────────────

  /**
   * Renames a photo file on disk.
   * Input:   { oldPath, newName, folderPath }
   * Returns: { success, newPath } or { success: false, error }
   */
  renameFile: (opts) => ipcRenderer.invoke('rename-file', opts),

  /** Reveals the given file in Finder (Mac) or Explorer (Windows). */
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),

  // ── Per-Folder Metadata File ──────────────────────────────────────────────────

  /**
   * Reads photo-map-data.json from the photo folder.
   * Input:   folderPath string
   * Returns: metadata object { version, pinColor, labels, photos: { [path]: {note,badGps,pinColor} } }
   */
  readMetadata: (folderPath) => ipcRenderer.invoke('read-metadata', folderPath),

  /**
   * Writes the full metadata object to photo-map-data.json in the photo folder.
   * Input:   { folderPath, metadata }
   * Returns: { success } or { success: false, error }
   */
  writeMetadata: (opts) => ipcRenderer.invoke('write-metadata', opts),

  // ── Lock File ─────────────────────────────────────────────────────────────────

  /**
   * Tries to acquire the lock for a photo folder.
   * Creates photo-map-data.lock if free; reports an error if someone else holds it.
   * Input:   folderPath string
   * Returns: { success: true }
   *       or { success: false, error: 'locked', lockedBy: { user, machine, timestamp } }
   *       or { success: false, error: 'unwritable', message: "..." }
   */
  acquireLock: (folderPath) => ipcRenderer.invoke('acquire-lock', folderPath),

  /**
   * Releases the lock for a folder (deletes the lock file if it belongs to us).
   * Input:   folderPath string
   */
  releaseLock: (folderPath) => ipcRenderer.invoke('release-lock', folderPath),

  /**
   * Reads the current lock state without modifying anything.
   * Used to power the "retry" button after a lock error.
   * Input:   folderPath string
   * Returns: { locked: false } or { locked: true, lockedBy: { user, machine, timestamp } }
   */
  checkLock: (folderPath) => ipcRenderer.invoke('check-lock', folderPath),

  // ── Folder Watching ───────────────────────────────────────────────────────────

  /** Start watching the folder for added/deleted photos. */
  watchFolder: (opts) => ipcRenderer.invoke('watch-folder', opts),

  /** Stop watching the folder. */
  stopWatching: () => ipcRenderer.invoke('stop-watching'),

  // ── Event Listeners (from main → renderer) ────────────────────────────────────

  /**
   * Register a callback for when a photo is added or removed from the folder.
   * The callback receives { type: 'add'|'remove', filePath }.
   */
  onFolderChanged: (cb) => ipcRenderer.on('folder-changed', (_, data) => cb(data)),

  /** Register a callback for when the user opens Settings via the menu bar. */
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),

  // ── Utility ───────────────────────────────────────────────────────────────────

  /** The current OS: 'darwin' (Mac), 'win32' (Windows), or 'linux'. */
  platform: process.platform,

  /**
   * Reads the README.md file that ships with the app and returns its text.
   * The path is resolved by the main process so it works whether running
   * from source or from inside a packaged installer.
   * Returns: the README text as a plain string.
   */
  readReadme: () => ipcRenderer.invoke('read-readme'),

  /**
   * Exports all GPS photos and their annotations to GeoJSON or CSV.
   * Input:   { photos, metadata, format } where format is 'geojson' or 'csv'
   * Returns: { success, count } or { success: false, error }
   */
  exportData: (opts) => ipcRenderer.invoke('export-data', opts),

  /**
   * Registers a callback that fires during a folder scan with live progress.
   * The callback receives { processed, total, withGps }.
   */
  onScanProgress: (cb) => ipcRenderer.on('scan-progress', (_, data) => cb(data)),

  /**
   * Converts a local filesystem path to a URL the browser can load as an image.
   * e.g. "/Users/sara/thumbnails/photo.jpg"  →  "file:///Users/sara/thumbnails/photo.jpg"
   */
  filePathToUrl: (filePath) => {
    if (!filePath) return null;
    return 'file://' + filePath.replace(/\\/g, '/');
  }
});

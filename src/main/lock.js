'use strict';

/*
 * lock.js — Cooperative folder-lock management
 *
 * We use a plain JSON file ("photo-map-data.lock") as a cooperative lock so
 * that only one Photo Map instance can edit a folder's annotations at a time.
 * This matters on shared network storage where multiple users might open the
 * same photo folder simultaneously.
 *
 * Limitations: cooperative only — someone can delete the lock file manually
 * as an intentional escape hatch for stuck locks.
 *
 * The module owns the in-memory lock state (UUID + folder path) so that
 * before-quit cleanup and UUID-based self-recognition both work correctly
 * without passing state through every call site.
 *
 * Tests call _resetLockState() between cases to avoid cross-contamination.
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const { isPidRunning } = require('../utils.js');

const LOCK_FILENAME = 'photo-map-data.lock';

// Session identity — set when we successfully create a lock file.
let _sessionLockUUID   = null;
let _currentLockFolder = null;

function lockFilePath(folderPath) {
  return path.join(folderPath, LOCK_FILENAME);
}

/*
 * Reads and returns the contents of the lock file, or null if none exists
 * or the file cannot be parsed.
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
 * Tries to create the lock file for the given folder using O_EXCL so the
 * creation is atomic (eliminates the TOCTOU race between "check + create").
 *
 * Returns:
 *   { success: true }                                    — we now hold the lock
 *   { success: false, error: 'locked',    lockedBy: … }  — held by another live instance
 *   { success: false, error: 'unwritable', message: … }  — folder is read-only
 */
function acquireLock(folderPath) {
  const lockPath = lockFilePath(folderPath);

  function tryCreate() {
    const uuid = crypto.randomUUID();
    const data = {
      uuid,
      user:      os.userInfo().username || os.userInfo().uid?.toString() || 'unknown',
      machine:   os.hostname() || 'unknown',
      pid:       process.pid,
      timestamp: new Date().toISOString()
    };
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
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
    _sessionLockUUID   = uuid;
    _currentLockFolder = folderPath;
    return { success: true };
  }

  const first = tryCreate();
  if (first !== null) return first;

  const existing = readLock(folderPath);

  if (!existing) {
    // File disappeared between our open attempt and our read — retry once.
    return tryCreate() ?? { success: false, error: 'locked', lockedBy: {} };
  }

  // Same session (e.g. Settings "Save & Reload" within a running session).
  if (existing.uuid && existing.uuid === _sessionLockUUID) {
    _currentLockFolder = folderPath;
    return { success: true };
  }

  // Different session: check if the owning PID is still alive.
  if (isPidRunning(existing.pid)) {
    return { success: false, error: 'locked', lockedBy: existing };
  }

  // Stale lock (app crashed without cleanup) — remove and retry.
  console.warn(
    `Removing stale lock left by PID ${existing.pid} (${existing.user}@${existing.machine})`
  );
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }

  return tryCreate() ?? { success: false, error: 'locked', lockedBy: existing };
}

/*
 * Releases the lock for the given folder (or the currently-held folder if
 * no path is supplied).  Only deletes the file if it belongs to this session.
 */
function releaseLock(folderPath) {
  const target = folderPath || _currentLockFolder;
  if (!target) return;
  try {
    const lp = lockFilePath(target);
    if (fs.existsSync(lp)) {
      const lock = readLock(target);
      const isOurs = lock && (
        (lock.uuid && lock.uuid === _sessionLockUUID) ||
        (!lock.uuid && lock.pid === process.pid)
      );
      if (isOurs) {
        fs.unlinkSync(lp);
        _sessionLockUUID = null;
      }
    }
  } catch (err) {
    console.warn('Could not release lock file:', err.message);
  }
  if (target === _currentLockFolder) _currentLockFolder = null;
}

// ─── Testing helpers ──────────────────────────────────────────────────────────

function _resetLockState() {
  _sessionLockUUID   = null;
  _currentLockFolder = null;
}

module.exports = {
  LOCK_FILENAME,
  lockFilePath,
  readLock,
  acquireLock,
  releaseLock,
  _resetLockState
};

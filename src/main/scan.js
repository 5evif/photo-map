'use strict';

/*
 * scan.js — Photo file discovery
 *
 * Walks a folder tree and returns the paths of all supported photo files,
 * skipping the app's own sidecar files so they never appear in the UI.
 *
 * Extracted from main.js to make the path-filtering logic unit-testable
 * without requiring Electron or the exifr EXIF library.
 */

const path = require('path');
const fs   = require('fs');
const { SUPPORTED_EXTENSIONS }         = require('../utils.js');
const { METADATA_FILENAME }            = require('./metadata-io.js');
const { LOCK_FILENAME }                = require('./lock.js');

/*
 * Recursively (or shallowly) collects all supported photo file paths under
 * folderPath, skipping the app's sidecar files and symlinks.
 *
 * Input:  folderPath — absolute path to the folder to scan
 *         recursive  — true to descend into subdirectories
 * Returns: array of absolute file-path strings (no guaranteed order)
 */
async function collectPhotoFiles(folderPath, recursive) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Cannot read ${dir}:`, err.message);
      return;
    }

    for (const entry of entries) {
      if (entry.name === METADATA_FILENAME) continue;
      if (entry.name === LOCK_FILENAME)     continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && recursive) {
        await walk(full);
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  }

  await walk(folderPath);
  return results;
}

module.exports = { collectPhotoFiles };

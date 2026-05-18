'use strict';

/*
 * metadata-io.js — Metadata file read/write with validation and atomic writes
 *
 * Owns all logic for photo-map-data.json:
 *   - Schema validation on read (strips corrupt entries rather than crashing)
 *   - Key translation: absolute paths in memory ↔ folder-relative paths on disk
 *     so the file is portable when the folder is moved or shared across machines
 *   - Atomic write via temp-file + rename to prevent corruption on crash
 *
 * Exported functions are used by main.js IPC handlers. They are also exported
 * for direct use in unit tests (no mocking required — tests use real temp dirs).
 */

const path = require('path');
const fs   = require('fs');

const METADATA_FILENAME = 'photo-map-data.json';
const DEFAULT_PIN_COLOR = '#4f8ef7';
const PIN_COLOR_RE      = /^#[0-9a-f]{6}$/i;

function metadataFilePath(folderPath) {
  return path.join(folderPath, METADATA_FILENAME);
}

/*
 * Returns true if a label object has the required fields with correct types.
 * Invalid labels are silently dropped on read to prevent map-render crashes.
 */
function isValidLabel(l) {
  return (
    l !== null && typeof l === 'object'
    && typeof l.id   === 'string'
    && typeof l.text === 'string'
    && typeof l.size === 'string'
    && typeof l.lat  === 'number' && Number.isFinite(l.lat) && l.lat >= -90  && l.lat <= 90
    && typeof l.lng  === 'number' && Number.isFinite(l.lng) && l.lng >= -180 && l.lng <= 180
  );
}

/*
 * Validates and sanitises a single photo-metadata object.
 * Returns a clean object with only known, type-correct fields.
 * Unknown keys are dropped so injected data cannot pollute the in-memory state.
 * Returns null if val is not an object (the caller should skip the entry).
 */
function sanitizePhotoMeta(val) {
  if (typeof val !== 'object' || val === null) return null;

  const out = {};

  if (typeof val.note   === 'string')  out.note   = val.note;
  if (typeof val.badGps === 'boolean') out.badGps = val.badGps;

  if (val.pinColor === null) {
    out.pinColor = null;
  } else if (typeof val.pinColor === 'string' && PIN_COLOR_RE.test(val.pinColor)) {
    out.pinColor = val.pinColor;
  }

  if (val.gpsOverride === null) {
    out.gpsOverride = null;
  } else if (
    val.gpsOverride && typeof val.gpsOverride === 'object'
    && Number.isFinite(val.gpsOverride.lat)
    && Number.isFinite(val.gpsOverride.lng)
  ) {
    out.gpsOverride = { lat: val.gpsOverride.lat, lng: val.gpsOverride.lng };
  }

  return out;
}

/*
 * Reads and validates photo-map-data.json from the given photo folder.
 * Returns a fully-populated metadata object; never throws.
 *
 * Key translation: relative keys on disk are absolutised before returning so
 * all in-memory lookups use absolute paths (matching state.photos[i].filePath).
 * Old-format files with absolute keys are migrated transparently on next write.
 */
function readMetadataFile(folderPath) {
  let raw;
  try {
    const fp = metadataFilePath(folderPath);
    if (fs.existsSync(fp)) raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (err) {
    console.error('Could not read metadata:', err.message);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, pinColor: DEFAULT_PIN_COLOR, labels: [], photos: {} };
  }

  const meta = {
    version:  typeof raw.version === 'number' ? raw.version : 1,
    pinColor: (typeof raw.pinColor === 'string' && PIN_COLOR_RE.test(raw.pinColor))
      ? raw.pinColor : DEFAULT_PIN_COLOR,
    labels:   Array.isArray(raw.labels) ? raw.labels.filter(isValidLabel) : [],
    photos:   {}
  };

  const rawPhotos = (
    raw.photos && typeof raw.photos === 'object' && !Array.isArray(raw.photos)
  ) ? raw.photos : {};

  for (const [key, val] of Object.entries(rawPhotos)) {
    const sanitized = sanitizePhotoMeta(val);
    if (sanitized === null) continue;
    // Absolute key → use as-is (old format, migrated on next write).
    // Relative key → join with folder to produce the absolute in-memory key.
    const absPath = path.isAbsolute(key) ? key : path.join(folderPath, key);
    meta.photos[absPath] = sanitized;
  }

  return meta;
}

/*
 * Writes the metadata object to photo-map-data.json using an atomic
 * temp-file + rename to prevent a half-written file on crash.
 *
 * Key translation: absolute in-memory keys are converted to forward-slash
 * relative paths before writing so the file is portable across machines
 * and operating systems (relative paths survive folder moves).
 *
 * Input:  folderPath — the photo folder that owns the metadata file
 *         metadata   — the full in-memory metadata object (absolute keys)
 * Returns: { success: true } or { success: false, error: string }
 */
function writeMetadataFileAtomic(folderPath, metadata) {
  try {
    const prefix = folderPath.endsWith(path.sep)
      ? folderPath
      : folderPath + path.sep;

    const relativePhotos = {};
    for (const [absPath, val] of Object.entries(metadata.photos || {})) {
      // Strip the folder prefix to get the relative path, then normalise to
      // forward slashes so the file is readable on any OS.
      const relKey = absPath.startsWith(prefix)
        ? absPath.slice(prefix.length).split(path.sep).join('/')
        : absPath.split(path.sep).join('/');
      relativePhotos[relKey] = val;
    }

    const toWrite   = { ...metadata, photos: relativePhotos };
    const finalPath = metadataFilePath(folderPath);
    const tmpPath   = finalPath + '.tmp';

    fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2), 'utf8');
    fs.renameSync(tmpPath, finalPath);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  METADATA_FILENAME,
  isValidLabel,
  sanitizePhotoMeta,
  readMetadataFile,
  writeMetadataFileAtomic
};

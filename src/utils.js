/*
 * utils.js — Shared Pure Utility Functions
 *
 * All exports are pure functions with no side effects.
 *
 * Used by:
 *   src/main/main.js         — isPidRunning, csvEscape, SUPPORTED_EXTENSIONS
 *   src/renderer/settings.js — markdownToHtml, escapeHtml (via Vite bundle)
 *   tests/unit.test.js       — all exports
 */

'use strict';

const { marked } = require('marked');

// Block dangerous URL schemes in links — only http/https/mailto are allowed.
// Safe inline formatting tags that marked may emit inside link text.
const _SAFE_INLINE = /^\/?(strong|em|code|del|s|br|b|i|u)$/i;

marked.use({
  renderer: {
    link({ href, title, text }) {
      const safe = /^(https?:|mailto:)/i.test(href || '') ? href : '#';
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      // Escape any HTML tag in link text that isn't a whitelisted inline element
      // so that <script>, <img onerror=…>, etc. can't inject via link text.
      const safeText = text.replace(/<(\/?)([a-z][a-z0-9]*)[^>]*>/gi, (match, slash, tag) =>
        _SAFE_INLINE.test(slash + tag) ? match : escapeHtml(match)
      );
      return `<a href="${safe}"${titleAttr} target="_blank" rel="noopener noreferrer">${safeText}</a>`;
    }
  }
});

// ─── Text / HTML ───────────────────────────────────────────────────────────────

/** Safely converts a string so it can be placed in innerHTML without XSS. */
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Returns the file extension including the leading dot, lower-cased.
 * Returns '' for names with no dot, or '.' only at the start (dotfiles).
 */
function getExtension(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i);
}

/**
 * Formats a lock-file timestamp string for display in the error overlay.
 * Returns a friendly local time string, or a safe fallback if the value
 * is missing, malformed, or not a valid date.
 *
 * Input:  ts — an ISO 8601 timestamp string (e.g. "2026-05-09T14:32:00.000Z")
 * Returns: a human-readable string like "May 9, 2026, 2:32 PM"
 */
function formatLockTimestamp(ts) {
  if (!ts) return 'unknown time';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  } catch {
    return ts;
  }
}

/**
 * Wraps a CSV field value in double-quotes and escapes any internal
 * double-quotes by doubling them (RFC 4180 §2.7).
 * Input:  v — any value (coerced to string)
 * Returns: a quoted CSV field string, e.g. `"hello ""world"""`
 */
function csvEscape(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

/**
 * Converts Markdown to HTML using the `marked` library.
 * Links are sanitised by the custom renderer above: only http/https/mailto
 * URLs are preserved; everything else (javascript:, data:, etc.) is replaced
 * with "#" so this function is safe to use with untrusted input.
 *
 * Input:  md — a Markdown string
 * Returns: an HTML string safe to set as innerHTML
 */
function markdownToHtml(md) {
  return marked.parse(md);
}

// ─── Process / OS ─────────────────────────────────────────────────────────────

/**
 * Checks whether a process with the given PID is currently running.
 * Uses process.kill(pid, 0) which probes for existence without sending a signal.
 * Input:  pid — a process ID number
 * Returns: boolean
 */
function isPidRunning(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ─── Date Formatting ──────────────────────────────────────────────────────────

/**
 * Formats an ISO date string for the info panel (long form with time).
 * Input:  isoString — ISO 8601 string
 * Returns: locale-formatted string, or the input unchanged if invalid
 */
function formatDate(isoString) {
  try {
    return new Date(isoString).toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  } catch { return isoString; }
}

/**
 * Formats an ISO date string for the photo list (short form, no time).
 * Input:  isoString — ISO 8601 string
 * Returns: locale-formatted string, or the HTML-escaped raw value if invalid
 */
function formatDateShort(isoString) {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch { return escapeHtml(String(isoString)); }
}

// ─── File Types ───────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp', '.dng', '.avif'
]);

// Formats the browser (Chromium) can decode directly — no thumbnail needed.
const BROWSER_IMAGE_FORMATS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * Classifies a settings-save event into the minimum work needed.
 * Pure function — used by applyNewSettings in scanner.js.
 *
 * Input:  flags — { apiKeyChanged, folderChanged, recursiveChanged, colorChanged }
 * Returns: 'color-only' | 'full-reload'
 */
function classifySettingsChange({ apiKeyChanged, folderChanged, recursiveChanged, colorChanged }) {
  if (colorChanged && !apiKeyChanged && !folderChanged && !recursiveChanged) return 'color-only';
  return 'full-reload';
}

// ─── Renderer business logic (pure, no DOM dependency) ───────────────────────

/**
 * Filters and sorts a photo array by filename, search query, and list filter.
 * Pure function — no DOM or state dependencies.
 *
 * Input:
 *   photos     — array of photo objects with { filePath, filename } at minimum
 *   query      — lowercase search string ('' means no text filter)
 *   listFilter — '' | 'bad' | 'note' | 'override'
 *   getMetaFn  — (filePath) => { badGps, note, gpsOverride } photo-metadata getter
 * Returns: filtered, sorted array (new array, input is not mutated)
 */
function filterAndSortPhotos(photos, query, listFilter, getMetaFn) {
  return [...photos]
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }))
    .filter(photo => {
      if (query && !photo.filename.toLowerCase().includes(query)) return false;
      const pm = getMetaFn(photo.filePath);
      if (listFilter === 'bad'      && !pm.badGps)        return false;
      if (listFilter === 'note'     && !pm.note?.trim())   return false;
      if (listFilter === 'override' && !pm.gpsOverride)    return false;
      return true;
    });
}

/**
 * Resolves the effective map coordinates for a photo, taking GPS override and
 * badGps flag into account.
 *
 * Input:
 *   pm    — photo-metadata object { badGps, gpsOverride: { lat, lng } | null }
 *   photo — raw photo data object { lat, lng, … }
 * Returns: { lat, lng } to use for map placement, or null if the photo should
 *          not appear on the map (flagged bad, or no usable coordinates).
 */
function resolveEffectiveCoords(pm, photo) {
  if (pm.badGps) return null;
  const lat = pm.gpsOverride ? pm.gpsOverride.lat : photo.lat;
  const lng = pm.gpsOverride ? pm.gpsOverride.lng : photo.lng;
  return (lat != null && lng != null) ? { lat, lng } : null;
}

// ─── Color Sanitization ───────────────────────────────────────────────────────

/**
 * Validates a color string is a safe hex value before use in style attributes.
 * Only accepts #rgb, #rrggbb, and #rrggbbaa — the formats produced by
 * <input type="color"> — to prevent CSS injection via metadata files.
 * Any other value is replaced with the default blue.
 */
function sanitizeColor(color) {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  return '#4f8ef7';
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  escapeHtml,
  getExtension,
  formatLockTimestamp,
  formatDate,
  formatDateShort,
  csvEscape,
  markdownToHtml,
  isPidRunning,
  sanitizeColor,
  classifySettingsChange,
  filterAndSortPhotos,
  resolveEffectiveCoords,
  SUPPORTED_EXTENSIONS,
  BROWSER_IMAGE_FORMATS
};

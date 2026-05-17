/*
 * utils.js — Shared Pure Utility Functions
 *
 * All exports are pure functions with no side effects and no external
 * dependencies (no Electron, no DOM, no file I/O).  This makes them
 * trivially testable with node:test without any mocking.
 *
 * Used by:
 *   src/main/main.js         — isPidRunning, csvEscape, SUPPORTED_EXTENSIONS
 *   src/renderer/renderer.js — escapeHtml, getExtension, formatLockTimestamp,
 *                              markdownToHtml, sanitizeColor (via Vite bundle)
 *   tests/unit.test.js       — all exports
 */

'use strict';

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
 * Converts a limited subset of Markdown to safe HTML.
 * Supports: h1–h3, paragraphs, blockquotes, bullet/ordered lists, fenced code
 * blocks, inline code, bold, links (http/https/mailto only), horizontal rules,
 * and tables.
 *
 * All user content is run through escapeHtml before output — this function
 * is safe to use with untrusted input.
 *
 * This implementation is kept in sync with the identical copy in renderer.js,
 * which cannot use require(). Update both files together.
 *
 * Input:  md — a Markdown string
 * Returns: an HTML string safe to set as innerHTML
 */
function markdownToHtml(md) {
  const lines = md.split('\n');
  const out   = [];
  let inCodeBlock   = false;
  let inList        = false;
  let inOrderedList = false;
  let inTable       = false;
  let tableLines    = [];
  let codeLang      = '';
  let codeLines     = [];

  function inlineFormat(raw) {
    let result = '';
    let i = 0;
    let textStart = 0;

    function flushPlain(end) {
      if (end > textStart) result += escapeHtml(raw.slice(textStart, end));
      textStart = end;
    }

    while (i < raw.length) {
      // Inline code: `text`
      if (raw[i] === '`') {
        const end = raw.indexOf('`', i + 1);
        if (end !== -1) {
          flushPlain(i);
          result += `<code class="md-inline-code">${escapeHtml(raw.slice(i + 1, end))}</code>`;
          i = end + 1; textStart = i; continue;
        }
      }
      // Link: [text](url)
      if (raw[i] === '[') {
        const cb = raw.indexOf(']', i + 1);
        if (cb !== -1 && raw[cb + 1] === '(') {
          const cp = raw.indexOf(')', cb + 2);
          if (cp !== -1) {
            flushPlain(i);
            const linkText = raw.slice(i + 1, cb);
            const url      = raw.slice(cb + 2, cp);
            const safeUrl  = /^https?:|^mailto:/i.test(url) ? url : '#';
            result += `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkText)}</a>`;
            i = cp + 1; textStart = i; continue;
          }
        }
      }
      // Bold: **text**
      if (raw[i] === '*' && raw[i + 1] === '*') {
        const end = raw.indexOf('**', i + 2);
        if (end !== -1) {
          flushPlain(i);
          result += `<strong>${escapeHtml(raw.slice(i + 2, end))}</strong>`;
          i = end + 2; textStart = i; continue;
        }
      }
      i++;
    }
    flushPlain(i);
    return result;
  }

  function flushList() {
    if (inList)        { out.push('</ul>'); inList        = false; }
    if (inOrderedList) { out.push('</ol>'); inOrderedList = false; }
  }

  function flushTable() {
    if (!inTable) return;
    inTable = false;
    const rows = tableLines;
    tableLines = [];
    if (rows.length < 2) {
      rows.forEach(r => out.push(`<p class="md-p">${inlineFormat(r)}</p>`));
      return;
    }
    const parseRow = line => line.split('|').slice(1, -1).map(c => c.trim());
    const isSep    = cells => cells.length > 0 && cells.every(c => /^[-: ]+$/.test(c));
    const headers  = parseRow(rows[0]);
    if (!isSep(parseRow(rows[1]))) {
      rows.forEach(r => out.push(`<p class="md-p">${inlineFormat(r)}</p>`));
      return;
    }
    let html = '<table class="md-table"><thead><tr>';
    headers.forEach(c => { html += `<th class="md-th">${inlineFormat(c)}</th>`; });
    html += '</tr></thead><tbody>';
    for (let j = 2; j < rows.length; j++) {
      html += '<tr>';
      parseRow(rows[j]).forEach(c => { html += `<td class="md-td">${inlineFormat(c)}</td>`; });
      html += '</tr>';
    }
    html += '</tbody></table>';
    out.push(html);
  }

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trimEnd();

    // ── Fenced code block ──────────────────────────────────────────────────
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        flushList(); flushTable();
        inCodeBlock = true;
        codeLang    = line.slice(3).trim();
        codeLines   = [];
      } else {
        const escaped  = codeLines.map(l => escapeHtml(l)).join('\n');
        const langAttr = codeLang ? ` class="md-code-lang-${escapeHtml(codeLang)}"` : '';
        out.push(`<pre class="md-code-block"><code${langAttr}>${escaped}</code></pre>`);
        inCodeBlock = false; codeLines = []; codeLang = '';
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(raw); continue; }

    // ── Blank line ─────────────────────────────────────────────────────────
    if (!line.trim()) { flushList(); flushTable(); continue; }

    // ── Table row ──────────────────────────────────────────────────────────
    if (line.trimStart().startsWith('|')) {
      flushList();
      inTable = true;
      tableLines.push(line);
      continue;
    }
    flushTable();

    // ── Headings ───────────────────────────────────────────────────────────
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h1) { flushList(); out.push(`<h1 class="md-h1">${inlineFormat(h1[1])}</h1>`); continue; }
    if (h2) { flushList(); out.push(`<h2 class="md-h2">${inlineFormat(h2[1])}</h2>`); continue; }
    if (h3) { flushList(); out.push(`<h3 class="md-h3">${inlineFormat(h3[1])}</h3>`); continue; }

    // ── Horizontal rule ────────────────────────────────────────────────────
    if (/^---+$/.test(line.trim())) { flushList(); out.push('<hr class="md-hr"/>'); continue; }

    // ── Blockquote ─────────────────────────────────────────────────────────
    const bq = line.match(/^> (.+)/);
    if (bq) {
      flushList();
      out.push(`<blockquote class="md-blockquote">${inlineFormat(bq[1])}</blockquote>`);
      continue;
    }

    // ── Unordered list ─────────────────────────────────────────────────────
    const li = line.match(/^[-*] (.+)/);
    if (li) {
      if (inOrderedList) { out.push('</ol>'); inOrderedList = false; }
      if (!inList) { out.push('<ul class="md-ul">'); inList = true; }
      out.push(`<li class="md-li">${inlineFormat(li[1])}</li>`);
      continue;
    }

    // ── Ordered list ───────────────────────────────────────────────────────
    const oli = line.match(/^\d+\. (.+)/);
    if (oli) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (!inOrderedList) { out.push('<ol class="md-ol">'); inOrderedList = true; }
      out.push(`<li class="md-li">${inlineFormat(oli[1])}</li>`);
      continue;
    }

    // ── Paragraph ──────────────────────────────────────────────────────────
    flushList();
    out.push(`<p class="md-p">${inlineFormat(line)}</p>`);
  }

  flushList();
  flushTable();
  if (inCodeBlock && codeLines.length) {
    out.push(`<pre class="md-code-block"><code>${codeLines.map(l => escapeHtml(l)).join('\n')}</code></pre>`);
  }
  return out.join('\n');
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

// ─── File Types ───────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp', '.dng', '.avif'
]);

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
  csvEscape,
  markdownToHtml,
  isPidRunning,
  sanitizeColor,
  SUPPORTED_EXTENSIONS
};

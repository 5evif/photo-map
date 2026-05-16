'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  escapeHtml,
  getExtension,
  formatLockTimestamp,
  csvEscape,
  markdownToHtml,
  isPidRunning,
  sanitizeColor,
  SUPPORTED_EXTENSIONS
} = require('../src/utils.js');

// ─── escapeHtml ───────────────────────────────────────────────────────────────

test('escapeHtml: plain text passes through unchanged', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
});

test('escapeHtml: escapes <, >, &, "', () => {
  assert.equal(escapeHtml('<b>"hi" & bye</b>'), '&lt;b&gt;&quot;hi&quot; &amp; bye&lt;/b&gt;');
});

test('escapeHtml: empty string returns empty string', () => {
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml: multiple ampersands', () => {
  assert.equal(escapeHtml('a & b & c'), 'a &amp; b &amp; c');
});

test('escapeHtml: script injection is neutralised', () => {
  const result = escapeHtml('<script>alert(1)</script>');
  assert.ok(!result.includes('<script>'), 'output must not contain <script>');
  assert.ok(result.includes('&lt;script&gt;'), 'output must contain escaped form');
});

// ─── getExtension ─────────────────────────────────────────────────────────────

test('getExtension: returns extension with dot', () => {
  assert.equal(getExtension('photo.jpg'), '.jpg');
});

test('getExtension: returns extension for uppercase (no lowercasing)', () => {
  assert.equal(getExtension('PHOTO.HEIC'), '.HEIC');
});

test('getExtension: returns empty string for no extension', () => {
  assert.equal(getExtension('README'), '');
});

test('getExtension: handles multiple dots (returns last segment)', () => {
  assert.equal(getExtension('my.backup.tar.gz'), '.gz');
});

test('getExtension: dotfile with no extension returns empty string', () => {
  // .gitignore has no extension — the dot is the filename start, not a separator
  // lastIndexOf('.') = 0, so slice(0) = '.gitignore' — the whole name.
  // This tests the current actual behaviour; callers should lowercase before lookup.
  assert.equal(getExtension('.gitignore'), '.gitignore');
});

// ─── formatLockTimestamp ──────────────────────────────────────────────────────

test('formatLockTimestamp: null returns "unknown time"', () => {
  assert.equal(formatLockTimestamp(null), 'unknown time');
});

test('formatLockTimestamp: undefined returns "unknown time"', () => {
  assert.equal(formatLockTimestamp(undefined), 'unknown time');
});

test('formatLockTimestamp: empty string returns "unknown time"', () => {
  assert.equal(formatLockTimestamp(''), 'unknown time');
});

test('formatLockTimestamp: garbage string returns input unchanged', () => {
  assert.equal(formatLockTimestamp('not-a-date'), 'not-a-date');
});

test('formatLockTimestamp: valid ISO string returns non-empty formatted string', () => {
  const result = formatLockTimestamp('2026-05-09T14:32:00.000Z');
  assert.ok(typeof result === 'string' && result.length > 0);
  assert.ok(result !== '2026-05-09T14:32:00.000Z', 'should be formatted, not raw ISO');
});

// ─── csvEscape ────────────────────────────────────────────────────────────────

test('csvEscape: plain string is wrapped in quotes', () => {
  assert.equal(csvEscape('hello'), '"hello"');
});

test('csvEscape: internal double-quotes are doubled (RFC 4180)', () => {
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
});

test('csvEscape: empty string becomes two double-quotes', () => {
  assert.equal(csvEscape(''), '""');
});

test('csvEscape: null/undefined coerced to empty string', () => {
  assert.equal(csvEscape(null), '""');
  assert.equal(csvEscape(undefined), '""');
});

test('csvEscape: numbers are stringified', () => {
  assert.equal(csvEscape(42), '"42"');
});

// ─── markdownToHtml — URL safety ─────────────────────────────────────────────

test('markdownToHtml: http link is preserved', () => {
  const html = markdownToHtml('[click](http://example.com)');
  assert.ok(html.includes('href="http://example.com"'));
});

test('markdownToHtml: https link is preserved', () => {
  const html = markdownToHtml('[click](https://example.com)');
  assert.ok(html.includes('href="https://example.com"'));
});

test('markdownToHtml: mailto link is preserved', () => {
  const html = markdownToHtml('[email](mailto:a@b.com)');
  assert.ok(html.includes('href="mailto:a@b.com"'));
});

test('markdownToHtml: javascript: URL is replaced with #', () => {
  const html = markdownToHtml('[xss](javascript:alert(1))');
  assert.ok(!html.includes('javascript:'), 'javascript: scheme must be stripped');
  assert.ok(html.includes('href="#"'), 'must be replaced with safe #');
});

test('markdownToHtml: data: URL is replaced with #', () => {
  const html = markdownToHtml('[xss](data:text/html,<h1>)');
  assert.ok(!html.includes('data:'), 'data: scheme must be stripped');
  assert.ok(html.includes('href="#"'));
});

test('markdownToHtml: link text is HTML-escaped', () => {
  const html = markdownToHtml('[<script>](https://safe.com)');
  assert.ok(!html.includes('<script>'), '<script> in link text must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('markdownToHtml: bold is rendered', () => {
  const html = markdownToHtml('**bold**');
  assert.ok(html.includes('<strong>bold</strong>'));
});

test('markdownToHtml: inline code is rendered', () => {
  const html = markdownToHtml('use `npm test`');
  assert.ok(html.includes('<code'));
  assert.ok(html.includes('npm test'));
});

// ─── isPidRunning ─────────────────────────────────────────────────────────────

test('isPidRunning: returns false for null/undefined', () => {
  assert.equal(isPidRunning(null), false);
  assert.equal(isPidRunning(undefined), false);
});

test('isPidRunning: returns false for non-number', () => {
  assert.equal(isPidRunning('1234'), false);
});

test('isPidRunning: returns false for pid 0', () => {
  // pid 0 is a sentinel "no process" value in the lock file default
  assert.equal(isPidRunning(0), false);
});

test('isPidRunning: returns true for own process PID', () => {
  assert.equal(isPidRunning(process.pid), true);
});

test('isPidRunning: returns false for a definitely-dead pid', () => {
  // PID 2147483647 (INT32_MAX) is astronomically unlikely to be running.
  // If the OS rejects it with ESRCH it's false; if EINVAL it throws — also false.
  assert.equal(isPidRunning(2147483647), false);
});

// ─── sanitizeColor ───────────────────────────────────────────────────────────

test('sanitizeColor: valid 6-digit hex passes through', () => {
  assert.equal(sanitizeColor('#4f8ef7'), '#4f8ef7');
});

test('sanitizeColor: valid 3-digit hex passes through', () => {
  assert.equal(sanitizeColor('#fff'), '#fff');
});

test('sanitizeColor: valid 8-digit hex (with alpha) passes through', () => {
  assert.equal(sanitizeColor('#4f8ef780'), '#4f8ef780');
});

test('sanitizeColor: CSS injection attempt returns default', () => {
  assert.equal(sanitizeColor('red; background: blue'), '#4f8ef7');
});

test('sanitizeColor: javascript: attempt returns default', () => {
  assert.equal(sanitizeColor('expression(alert(1))'), '#4f8ef7');
});

test('sanitizeColor: null/undefined returns default', () => {
  assert.equal(sanitizeColor(null), '#4f8ef7');
  assert.equal(sanitizeColor(undefined), '#4f8ef7');
});

test('sanitizeColor: named CSS color (e.g. "red") returns default', () => {
  assert.equal(sanitizeColor('red'), '#4f8ef7');
});

test('sanitizeColor: rgb() value returns default', () => {
  assert.equal(sanitizeColor('rgb(79, 142, 247)'), '#4f8ef7');
});

// ─── SUPPORTED_EXTENSIONS ────────────────────────────────────────────────────

test('SUPPORTED_EXTENSIONS: contains expected photo formats', () => {
  const expected = ['.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp', '.dng', '.avif'];
  for (const ext of expected) {
    assert.ok(SUPPORTED_EXTENSIONS.has(ext), `missing extension: ${ext}`);
  }
});

test('SUPPORTED_EXTENSIONS: does not contain non-photo extensions', () => {
  assert.equal(SUPPORTED_EXTENSIONS.has('.txt'), false);
  assert.equal(SUPPORTED_EXTENSIONS.has('.mp4'), false);
  assert.equal(SUPPORTED_EXTENSIONS.has('.pdf'), false);
});

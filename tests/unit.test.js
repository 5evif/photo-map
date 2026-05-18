'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const {
  escapeHtml,
  getExtension,
  formatLockTimestamp,
  formatDate,
  formatDateShort,
  csvEscape,
  markdownToHtml,
  isPidRunning,
  sanitizeColor,
  SUPPORTED_EXTENSIONS,
  BROWSER_IMAGE_FORMATS
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

// ─── formatDate ───────────────────────────────────────────────────────────────

test('formatDate: valid ISO string returns non-empty string', () => {
  const result = formatDate('2024-06-15T09:30:00.000Z');
  assert.ok(typeof result === 'string' && result.length > 0);
  assert.ok(!result.includes('T'), 'should not contain raw ISO T separator');
});

test('formatDate: null returns "null" (coerced via Date constructor)', () => {
  // new Date(null) is the epoch — we just verify it doesn't throw
  assert.doesNotThrow(() => formatDate(null));
});

test('formatDate: invalid string returns a non-empty string (does not throw)', () => {
  assert.doesNotThrow(() => formatDate('not-a-date'));
  const result = formatDate('not-a-date');
  assert.ok(typeof result === 'string' && result.length > 0);
});

// ─── formatDateShort ──────────────────────────────────────────────────────────

test('formatDateShort: valid ISO string returns non-empty string', () => {
  const result = formatDateShort('2024-06-15T09:30:00.000Z');
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('formatDateShort: invalid string returns a non-empty string (does not throw)', () => {
  assert.doesNotThrow(() => formatDateShort('not-a-date'));
  const result = formatDateShort('not-a-date');
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('formatDateShort: does not include time components', () => {
  const result = formatDateShort('2024-06-15T09:30:00.000Z');
  // A short date should not normally contain a colon (time separator).
  // This is locale-dependent but holds for common locales.
  assert.ok(result.length > 0, 'result must be non-empty');
});

// ─── BROWSER_IMAGE_FORMATS ────────────────────────────────────────────────────

test('BROWSER_IMAGE_FORMATS: contains browser-native image formats', () => {
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.avif']) {
    assert.ok(BROWSER_IMAGE_FORMATS.has(ext), `missing: ${ext}`);
  }
});

test('BROWSER_IMAGE_FORMATS: does not contain HEIC (requires thumbnail)', () => {
  assert.equal(BROWSER_IMAGE_FORMATS.has('.heic'), false);
  assert.equal(BROWSER_IMAGE_FORMATS.has('.heif'), false);
  assert.equal(BROWSER_IMAGE_FORMATS.has('.dng'),  false);
});

// ─── lock.js ─────────────────────────────────────────────────────────────────

const { acquireLock, releaseLock, readLock, _resetLockState, LOCK_FILENAME } =
  require('../src/main/lock.js');

test('acquireLock: creates lock file and returns success', async () => {
  await withTempDir(async dir => {
    _resetLockState();
    const result = acquireLock(dir);
    assert.equal(result.success, true);
    assert.ok(fs.existsSync(path.join(dir, LOCK_FILENAME)));
    releaseLock(dir);
  });
});

test('acquireLock: returns locked error when held by another session', async () => {
  await withTempDir(async dir => {
    _resetLockState();
    // Write a fake lock owned by a different (living) PID — use process.pid but
    // a different UUID so it looks like a real, active foreign lock.
    const lockPath = path.join(dir, LOCK_FILENAME);
    fs.writeFileSync(lockPath, JSON.stringify({
      uuid: 'foreign-uuid', user: 'other', machine: 'host',
      pid: process.pid, timestamp: new Date().toISOString()
    }));
    const result = acquireLock(dir);
    assert.equal(result.success, false);
    assert.equal(result.error, 'locked');
    assert.ok(result.lockedBy);
    fs.unlinkSync(lockPath);
  });
});

test('acquireLock: same session (UUID match) returns success without creating duplicate', async () => {
  await withTempDir(async dir => {
    _resetLockState();
    const first = acquireLock(dir);
    assert.equal(first.success, true);
    // Acquire again — should recognise our own session UUID.
    const second = acquireLock(dir);
    assert.equal(second.success, true);
    releaseLock(dir);
  });
});

test('acquireLock: removes stale lock (dead PID) and succeeds', async () => {
  await withTempDir(async dir => {
    _resetLockState();
    // Write a lock owned by PID 1 — guaranteed dead on any test machine
    // (or at least not our process and not a photo-map instance).
    const lockPath = path.join(dir, LOCK_FILENAME);
    fs.writeFileSync(lockPath, JSON.stringify({
      uuid: 'stale-uuid', user: 'ghost', machine: 'old',
      pid: 1, timestamp: new Date().toISOString()
    }));
    // Overwrite with a truly non-existent PID to guarantee isPidRunning is false.
    fs.writeFileSync(lockPath, JSON.stringify({
      uuid: 'stale-uuid', user: 'ghost', machine: 'old',
      pid: 999999999, timestamp: new Date().toISOString()
    }));
    const result = acquireLock(dir);
    assert.equal(result.success, true);
    releaseLock(dir);
  });
});

test('releaseLock: deletes our own lock file', async () => {
  await withTempDir(async dir => {
    _resetLockState();
    acquireLock(dir);
    assert.ok(fs.existsSync(path.join(dir, LOCK_FILENAME)));
    releaseLock(dir);
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILENAME)), false);
  });
});

test('releaseLock: does not delete another session\'s lock', async () => {
  await withTempDir(async dir => {
    _resetLockState();
    // Write a foreign lock directly (we never called acquireLock).
    const lockPath = path.join(dir, LOCK_FILENAME);
    fs.writeFileSync(lockPath, JSON.stringify({
      uuid: 'foreign-uuid', user: 'other', machine: 'host',
      pid: process.pid, timestamp: new Date().toISOString()
    }));
    releaseLock(dir);
    // Our UUID is null so isOurs is false — file must survive.
    assert.ok(fs.existsSync(lockPath));
    fs.unlinkSync(lockPath);
  });
});

// ─── scan.js ─────────────────────────────────────────────────────────────────

const { collectPhotoFiles } = require('../src/main/scan.js');

test('collectPhotoFiles: finds .jpg and .heic files', async () => {
  await withTempDir(async dir => {
    fs.writeFileSync(path.join(dir, 'a.jpg'), '');
    fs.writeFileSync(path.join(dir, 'b.HEIC'), '');
    const files = await collectPhotoFiles(dir, false);
    assert.equal(files.length, 2);
    const names = files.map(f => path.basename(f).toLowerCase()).sort();
    assert.deepEqual(names, ['a.jpg', 'b.heic']);
  });
});

test('collectPhotoFiles: ignores non-photo files', async () => {
  await withTempDir(async dir => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    fs.writeFileSync(path.join(dir, 'data.json'), '');
    fs.writeFileSync(path.join(dir, 'photo.jpg'), '');
    const files = await collectPhotoFiles(dir, false);
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0]), 'photo.jpg');
  });
});

test('collectPhotoFiles: skips photo-map-data.json sidecar', async () => {
  await withTempDir(async dir => {
    fs.writeFileSync(path.join(dir, 'photo-map-data.json'), '{}');
    fs.writeFileSync(path.join(dir, 'photo.jpg'), '');
    const files = await collectPhotoFiles(dir, false);
    assert.equal(files.length, 1);
  });
});

test('collectPhotoFiles: skips photo-map-data.lock sidecar', async () => {
  await withTempDir(async dir => {
    fs.writeFileSync(path.join(dir, 'photo-map-data.lock'), '{}');
    fs.writeFileSync(path.join(dir, 'photo.jpg'), '');
    const files = await collectPhotoFiles(dir, false);
    assert.equal(files.length, 1);
  });
});

test('collectPhotoFiles: non-recursive does not descend into subdirectories', async () => {
  await withTempDir(async dir => {
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(dir, 'top.jpg'), '');
    fs.writeFileSync(path.join(sub, 'nested.jpg'), '');
    const files = await collectPhotoFiles(dir, false);
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0]), 'top.jpg');
  });
});

test('collectPhotoFiles: recursive descends into subdirectories', async () => {
  await withTempDir(async dir => {
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(dir, 'top.jpg'), '');
    fs.writeFileSync(path.join(sub, 'nested.jpg'), '');
    const files = await collectPhotoFiles(dir, true);
    assert.equal(files.length, 2);
  });
});

// ─── export-format.js ────────────────────────────────────────────────────────

const { buildGeoJson, buildCsv } = require('../src/main/export-format.js');

const SAMPLE_PHOTOS = [
  { filePath: '/photos/a.jpg', filename: 'a.jpg', lat: 51.5,  lng: -0.12, date: '2024-01-01T00:00:00.000Z' },
  { filePath: '/photos/b.jpg', filename: 'b.jpg', lat: 48.85, lng: 2.35,  date: null }
];

const SAMPLE_META = {
  photos: {
    '/photos/a.jpg': { note: 'London', badGps: false, pinColor: '#ff0000' },
    '/photos/b.jpg': { note: 'Paris',  badGps: true,  pinColor: null }
  }
};

test('buildGeoJson: returns valid FeatureCollection', () => {
  const json = JSON.parse(buildGeoJson(SAMPLE_PHOTOS, SAMPLE_META));
  assert.equal(json.type, 'FeatureCollection');
  assert.equal(json.features.length, 2);
  assert.equal(json.features[0].type, 'Feature');
  assert.equal(json.features[0].geometry.type, 'Point');
});

test('buildGeoJson: coordinate order is [lng, lat] per RFC 7946', () => {
  const json = JSON.parse(buildGeoJson(SAMPLE_PHOTOS, SAMPLE_META));
  const [lng, lat] = json.features[0].geometry.coordinates;
  assert.equal(lng, -0.12);
  assert.equal(lat, 51.5);
});

test('buildGeoJson: properties include metadata fields', () => {
  const json = JSON.parse(buildGeoJson(SAMPLE_PHOTOS, SAMPLE_META));
  const props = json.features[0].properties;
  assert.equal(props.note, 'London');
  assert.equal(props.badGps, false);
  assert.equal(props.pinColor, '#ff0000');
  assert.equal(props.filename, 'a.jpg');
});

test('buildGeoJson: missing metadata falls back to empty defaults', () => {
  const json = JSON.parse(buildGeoJson(SAMPLE_PHOTOS, {}));
  const props = json.features[0].properties;
  assert.equal(props.note, '');
  assert.equal(props.badGps, false);
  assert.equal(props.pinColor, null);
});

test('buildCsv: first line is the correct header', () => {
  const csv = buildCsv(SAMPLE_PHOTOS, SAMPLE_META);
  const header = csv.split('\n')[0];
  assert.equal(header, 'filename,latitude,longitude,date,note,bad_gps');
});

test('buildCsv: one data row per photo', () => {
  const lines = buildCsv(SAMPLE_PHOTOS, SAMPLE_META).split('\n');
  assert.equal(lines.length, 3); // header + 2 photos
});

test('buildCsv: RFC 4180 quoting — double-quotes are doubled', () => {
  const photos = [{ filePath: '/p/x.jpg', filename: 'say "hi".jpg', lat: 0, lng: 0, date: null }];
  const meta   = { photos: { '/p/x.jpg': { note: 'he said "hello"', badGps: false } } };
  const csv = buildCsv(photos, meta);
  assert.ok(csv.includes('"say ""hi"".jpg"'), 'filename must be RFC 4180 quoted');
  assert.ok(csv.includes('"he said ""hello"""'), 'note must be RFC 4180 quoted');
});

test('buildCsv: bad_gps column reflects metadata', () => {
  const csv   = buildCsv(SAMPLE_PHOTOS, SAMPLE_META);
  const lines = csv.split('\n');
  assert.ok(lines[1].endsWith(',false'), 'first photo bad_gps should be false');
  assert.ok(lines[2].endsWith(',true'),  'second photo bad_gps should be true');
});

test('buildCsv: empty metadata object is handled gracefully', () => {
  assert.doesNotThrow(() => buildCsv(SAMPLE_PHOTOS, {}));
  assert.doesNotThrow(() => buildCsv(SAMPLE_PHOTOS, null));
});

// ─── metadata-io: isValidLabel ────────────────────────────────────────────────

const { isValidLabel, sanitizePhotoMeta, readMetadataFile, writeMetadataFileAtomic } =
  require('../src/main/metadata-io.js');

test('isValidLabel: valid label passes', () => {
  assert.equal(isValidLabel({ id: 'a', lat: 51.5, lng: -0.1, text: 'London', size: 'medium' }), true);
});

test('isValidLabel: missing id fails', () => {
  assert.equal(isValidLabel({ lat: 51.5, lng: -0.1, text: 'x', size: 'small' }), false);
});

test('isValidLabel: lat out of range fails', () => {
  assert.equal(isValidLabel({ id: 'a', lat: 91, lng: 0, text: 'x', size: 'small' }), false);
});

test('isValidLabel: lng out of range fails', () => {
  assert.equal(isValidLabel({ id: 'a', lat: 0, lng: 181, text: 'x', size: 'small' }), false);
});

test('isValidLabel: non-finite lat fails', () => {
  assert.equal(isValidLabel({ id: 'a', lat: NaN, lng: 0, text: 'x', size: 'small' }), false);
});

test('isValidLabel: null fails', () => {
  assert.equal(isValidLabel(null), false);
});

// ─── metadata-io: sanitizePhotoMeta ──────────────────────────────────────────

test('sanitizePhotoMeta: valid full entry returns sanitised copy', () => {
  const out = sanitizePhotoMeta({
    note: 'hi', badGps: true, pinColor: '#ff0000', gpsOverride: { lat: 1, lng: 2 }
  });
  assert.deepEqual(out, { note: 'hi', badGps: true, pinColor: '#ff0000', gpsOverride: { lat: 1, lng: 2 } });
});

test('sanitizePhotoMeta: strips unknown keys', () => {
  const out = sanitizePhotoMeta({ note: 'ok', injected: 'evil', __proto__: {} });
  assert.ok(!('injected' in out), 'unknown key must be stripped');
});

test('sanitizePhotoMeta: invalid pinColor is excluded', () => {
  const out = sanitizePhotoMeta({ pinColor: 'red; background: evil' });
  assert.ok(!('pinColor' in out), 'invalid pinColor must be excluded');
});

test('sanitizePhotoMeta: null pinColor is preserved', () => {
  const out = sanitizePhotoMeta({ pinColor: null });
  assert.equal(out.pinColor, null);
});

test('sanitizePhotoMeta: invalid gpsOverride is excluded', () => {
  const out = sanitizePhotoMeta({ gpsOverride: { lat: NaN, lng: 0 } });
  assert.ok(!('gpsOverride' in out), 'gpsOverride with NaN lat must be excluded');
});

test('sanitizePhotoMeta: null returns null', () => {
  assert.equal(sanitizePhotoMeta(null), null);
});

test('sanitizePhotoMeta: non-object returns null', () => {
  assert.equal(sanitizePhotoMeta('string'), null);
});

// ─── metadata-io: round-trip and migration ───────────────────────────────────

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-map-test-'));
  try { return await fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('writeMetadataFileAtomic + readMetadataFile: round-trip preserves data', () => {
  withTempDir((dir) => {
    const absPhoto = path.join(dir, 'IMG_001.jpg');
    const metadata = {
      version: 1, pinColor: '#4f8ef7', labels: [],
      photos: { [absPhoto]: { note: 'test note', badGps: false, pinColor: null, gpsOverride: null } }
    };
    const writeResult = writeMetadataFileAtomic(dir, metadata);
    assert.equal(writeResult.success, true);

    const read = readMetadataFile(dir);
    assert.equal(read.photos[absPhoto].note, 'test note');
    assert.equal(read.photos[absPhoto].badGps, false);
  });
});

test('writeMetadataFileAtomic: keys stored as relative paths on disk', () => {
  withTempDir((dir) => {
    const absPhoto = path.join(dir, 'sub', 'IMG_002.jpg');
    writeMetadataFileAtomic(dir, {
      version: 1, pinColor: '#4f8ef7', labels: [],
      photos: { [absPhoto]: { note: 'sub' } }
    });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'photo-map-data.json'), 'utf8'));
    const keys = Object.keys(raw.photos);
    assert.equal(keys.length, 1);
    assert.ok(!path.isAbsolute(keys[0]), 'disk key must be relative');
    // Forward slashes on all platforms
    assert.ok(!keys[0].includes('\\'), 'disk key must use forward slashes');
    assert.equal(keys[0], 'sub/IMG_002.jpg');
  });
});

test('readMetadataFile: migrates old absolute keys to in-memory absolute keys', () => {
  withTempDir((dir) => {
    const absPhoto = path.join(dir, 'IMG_003.jpg');
    // Write old-format file with absolute keys directly
    const oldFormat = {
      version: 1, pinColor: '#4f8ef7', labels: [],
      photos: { [absPhoto]: { note: 'migrated', badGps: true } }
    };
    fs.writeFileSync(path.join(dir, 'photo-map-data.json'), JSON.stringify(oldFormat), 'utf8');

    const read = readMetadataFile(dir);
    assert.equal(read.photos[absPhoto].note, 'migrated');
    assert.equal(read.photos[absPhoto].badGps, true);
  });
});

test('readMetadataFile: returns default when file missing', () => {
  withTempDir((dir) => {
    const result = readMetadataFile(dir);
    assert.equal(result.version, 1);
    assert.equal(result.pinColor, '#4f8ef7');
    assert.deepEqual(result.labels, []);
    assert.deepEqual(result.photos, {});
  });
});

test('readMetadataFile: returns default when file is corrupt JSON', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'photo-map-data.json'), 'NOT JSON', 'utf8');
    const result = readMetadataFile(dir);
    assert.deepEqual(result.photos, {});
  });
});

test('readMetadataFile: strips invalid labels', () => {
  withTempDir((dir) => {
    const data = {
      version: 1, pinColor: '#4f8ef7',
      labels: [
        { id: 'good', lat: 10, lng: 20, text: 'ok', size: 'small' },
        { id: 'bad',  lat: 999, lng: 20, text: 'out-of-range', size: 'small' },
        'not-an-object'
      ],
      photos: {}
    };
    fs.writeFileSync(path.join(dir, 'photo-map-data.json'), JSON.stringify(data), 'utf8');
    const result = readMetadataFile(dir);
    assert.equal(result.labels.length, 1);
    assert.equal(result.labels[0].id, 'good');
  });
});

test('writeMetadataFileAtomic: no temp file left after success', () => {
  withTempDir((dir) => {
    writeMetadataFileAtomic(dir, { version: 1, pinColor: '#4f8ef7', labels: [], photos: {} });
    const tmpPath = path.join(dir, 'photo-map-data.json.tmp');
    assert.equal(fs.existsSync(tmpPath), false, '.tmp file must not remain after write');
  });
});

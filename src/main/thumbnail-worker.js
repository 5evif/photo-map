/*
 * thumbnail-worker.js — Background Thread for Thumbnail Generation
 *
 * This file runs in a Node.js worker thread, spawned by main.js whenever a
 * thumbnail needs to be generated for a photo that is not already cached.
 * Running in a separate thread means slow image decoding — especially for
 * large HEIC files from iPhones, which can take 1–3 seconds — never blocks
 * the main process or makes the app feel frozen.
 *
 * How it works:
 *   1. main.js spawns this worker with { filePath, thumbPath } in workerData.
 *   2. This file tries to generate a JPEG thumbnail using three strategies,
 *      in order from fastest to most thorough (see below).
 *   3. It posts one result message back to main.js and then exits.
 *
 * Three thumbnail strategies, tried in order:
 *
 *   Attempt 1 — Embedded JPEG preview (HEIC/HEIF only, fastest)
 *     iPhones bake a full-resolution JPEG preview into every HEIC file.
 *     The exifr library can extract this preview without decoding the HEIC
 *     pixel data at all. If the preview was stripped by an editing workflow,
 *     this step fails silently and we move to Attempt 2.
 *
 *   Attempt 2 — heic-convert full decode (HEIC/HEIF only, reliable)
 *     A pure JavaScript HEIC decoder that reads and converts the actual pixel
 *     data. Works on any HEIC file regardless of editing history. Slower than
 *     Attempt 1 but does not require any native binaries.
 *
 *   Attempt 3 — sharp direct decode (all other formats, and HEIC fallback)
 *     The sharp library decodes JPEG, PNG, WebP, DNG, AVIF, and similar
 *     formats via its bundled libvips. Also used as a last resort for HEIC
 *     if both earlier attempts fail (requires libheif to be installed).
 *
 * Communication:
 *   Receives (via workerData): { filePath, thumbPath }
 *     filePath  — full path to the source photo on disk
 *     thumbPath — full path where the output JPEG thumbnail should be written
 *   Posts one message: { success: true, thumbPath }
 *                   or { success: false, error: "error message" }
 */

'use strict';

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

const JPEG_QUALITY  = 85;
const SIDEBAR_WIDTH = 800; // max width for sidebar preview thumbnails

// Formats the browser can't decode natively — the generated JPEG is the only
// display image, so it must be full-resolution rather than a small preview.
const FULL_RES_EXTENSIONS = new Set(['.heic', '.heif', '.dng']);

const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

async function generateThumbnail(filePath, thumbPath) {
  const ext = path.extname(filePath).toLowerCase();

  if (HEIC_EXTENSIONS.has(ext)) {

    // ── Attempt 1: embedded JPEG preview via exifr (fastest) ──────────────────
    // iPhones bake a full-resolution JPEG preview into every HEIC file.
    // Extracting it avoids a full HEIC decode entirely.
    try {
      const exifr         = require('exifr');
      const previewBuffer = await exifr.thumbnail(filePath);
      if (previewBuffer && previewBuffer.length > 0) {
        const sharp = require('sharp');
        await sharp(previewBuffer)
          .rotate()
          .jpeg({ quality: JPEG_QUALITY })
          .toFile(thumbPath);
        return { success: true, thumbPath };
      }
    } catch {
      // No embedded preview — fall through to heic-convert.
    }

    // ── Attempt 2: heic-convert (pure JS full decode) ──────────────────────────
    // Works on any HEIC file regardless of whether it has an embedded preview.
    try {
      const heicConvert = require('heic-convert');
      const inputBuffer = fs.readFileSync(filePath);
      const jpegBuffer  = await heicConvert({
        buffer:  inputBuffer,
        format:  'JPEG',
        quality: JPEG_QUALITY / 100   // heic-convert uses 0–1 scale
      });
      const sharp = require('sharp');
      await sharp(Buffer.from(jpegBuffer))
        .rotate()
        .jpeg({ quality: JPEG_QUALITY })
        .toFile(thumbPath);
      return { success: true, thumbPath };
    } catch {
      // heic-convert failed — fall through to sharp direct.
    }
  }

  // ── All other formats (and final HEIC fallback) ────────────────────────────
  try {
    const sharp = require('sharp');
    const pipeline = sharp(filePath).rotate();
    if (!FULL_RES_EXTENSIONS.has(ext)) {
      pipeline.resize(SIDEBAR_WIDTH, null, { withoutEnlargement: true });
    }
    await pipeline.jpeg({ quality: JPEG_QUALITY }).toFile(thumbPath);
    return { success: true, thumbPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// The worker receives its input via workerData (set at thread creation time).
generateThumbnail(workerData.filePath, workerData.thumbPath)
  .then(result => parentPort.postMessage(result))
  .catch(err   => parentPort.postMessage({ success: false, error: err.message }));

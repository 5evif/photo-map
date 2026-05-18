// ─── Thumbnail Pre-generation ─────────────────────────────────────────────────
//
// Manages the pre-generation progress overlay and triggers thumbnail generation
// for non-native formats (HEIC, HEIF, DNG) after each scan when enabled.

import { state, el } from './state.js';

// Extensions that require thumbnail generation (mirrors PREGEN_EXTENSIONS in main.js).
const PREGEN_EXTENSIONS = new Set(['.heic', '.heif', '.dng']);

function _getExt(filename) {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

function _showOverlay(total) {
  el.pregenProgressText.textContent = `0 / ${total}`;
  el.pregenProgressBar.style.width  = '0%';
  el.pregenOverlay.classList.remove('hidden');
}

function _updateOverlay(done, total) {
  el.pregenProgressText.textContent = `${done} / ${total}`;
  el.pregenProgressBar.style.width  = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
}

function _hideOverlay() {
  el.pregenOverlay.classList.add('hidden');
}

// Called once during bindAppEvents to wire the cancel button.
export function registerPregenEvents() {
  el.pregenCancelBtn.addEventListener('click', () => {
    window.photoMap.cancelPregen();
  });

  window.photoMap.onPregenProgress(({ done, total, cancelled }) => {
    if (total === 0 || cancelled || done >= total) {
      _hideOverlay();
      return;
    }
    _updateOverlay(done, total);
  });
}

// Called after each scan when state.pregenThumbnails is true.
// photos — the current state.photos array.
export async function runPregen(photos) {
  if (!state.pregenThumbnails) return;

  const filePaths = photos
    .filter(p => PREGEN_EXTENSIONS.has(_getExt(p.filename)))
    .map(p => p.filePath);

  if (!filePaths.length) return;

  // Show overlay only if there is actually work to do (main process pre-checks cache).
  // We show it optimistically here; the first progress event with total=0 hides it.
  _showOverlay(filePaths.length);

  await window.photoMap.pregenThumbnails(filePaths);
  // Final hide is handled by the onPregenProgress handler when done >= total.
}

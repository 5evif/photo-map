// ─── Metadata (photo-map-data.json) ───────────────────────────────────────────
//
// Reads and writes the per-folder sidecar file that stores notes, bad-GPS flags,
// per-photo pin colors, GPS overrides, and map labels.  All per-photo metadata
// is keyed by the absolute file path.

import { state } from './state.js';
import { setStatus } from './state.js';

export async function loadMetadata() {
  state.meta = await window.photoMap.readMetadata(state.folderPath);
  state.meta.photos  = state.meta.photos  || {};
  state.meta.labels  = state.meta.labels  || [];
  state.meta.pinColor = state.meta.pinColor || state.pinColor;
}

export async function saveMetadata() {
  const result = await window.photoMap.writeMetadata({
    folderPath: state.folderPath,
    metadata:   state.meta
  });
  if (result && !result.success) {
    setStatus(`⚠ Could not save annotations: ${result.error}`);
  }
}

export function getPhotoMeta(filePath) {
  if (!state.meta.photos[filePath]) {
    state.meta.photos[filePath] = { note: '', badGps: false, pinColor: null, gpsOverride: null };
  }
  return state.meta.photos[filePath];
}

// ─── Metadata (photo-map-data.json) ───────────────────────────────────────────
//
// Reads and writes the per-folder sidecar file. Absolute file-path keys are used
// in memory; the main process converts them to folder-relative keys on disk so
// the file is portable when the folder is moved or shared.

import { state, setStatus } from './state.js';

export async function loadMetadata() {
  state.meta = await window.photoMap.readMetadata(state.folderPath);
  state.meta.photos   = state.meta.photos   || {};
  state.meta.labels   = state.meta.labels   || [];
  state.meta.pinColor = state.meta.pinColor || state.pinColor;
}

// Writes are debounced to 300 ms so that rapid successive calls (e.g. multiple
// UI toggles or note edits) coalesce into a single IPC round-trip. All callers
// that await saveMetadata() within the window share the same batch and resolve
// together once the write completes.
let _saveTimer            = null;
const _batchResolvers     = [];

export function saveMetadata() {
  return new Promise((resolve) => {
    _batchResolvers.push(resolve);
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
      _saveTimer = null;
      const resolvers = _batchResolvers.splice(0);
      const result = await window.photoMap.writeMetadata({
        folderPath: state.folderPath,
        metadata:   state.meta
      });
      if (result && !result.success) setStatus(`⚠ Could not save annotations: ${result.error}`);
      for (const r of resolvers) r();
    }, 300);
  });
}

export function getPhotoMeta(filePath) {
  if (!state.meta.photos[filePath]) {
    state.meta.photos[filePath] = { note: '', badGps: false, pinColor: null, gpsOverride: null };
  }
  return state.meta.photos[filePath];
}

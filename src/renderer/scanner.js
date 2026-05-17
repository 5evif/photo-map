// ─── Scanner & Folder Watch ───────────────────────────────────────────────────
//
// Owns the scan/watch pipeline, file-system change handling, the in-place
// settings-reload flow, and the lock-error + folder-name UI helpers.
// Extracted from renderer.js so the orchestrator stays focused on screen
// switching and top-level event wiring.

import { formatLockTimestamp, classifySettingsChange, DEFAULT_PIN_COLOR } from '../utils.js';
import { state, el, setStatus, CURRENT_METADATA_VERSION }               from './state.js';
import { loadMetadata, saveMetadata, getPhotoMeta }    from './metadata.js';
import {
  placePhotoMarkers, createPhotoMarker, clearPhotoMarkers,
  fitMapToMarkers, setMarkerHighlight, updateTileApiKey, refreshAllMarkerPins
} from './map.js';
import { renderPhotoList }         from './photoList.js';
import { closeInfoPanel }          from './infoPanel.js';
import { renderAllLabels, clearAllLabels } from './labels.js';
import { closeSettingsPanel }      from './settings.js';

// ─── Scan ─────────────────────────────────────────────────────────────────────

export async function scanAndDisplay() {
  setStatus('Scanning photos…');
  clearPhotoMarkers();

  const result = await window.photoMap.scanFolder({
    folderPath: state.folderPath, recursive: state.recursive
  });

  if (result.error) { setStatus(`⚠ ${result.error}`); return; }

  state.photos = result.photos;
  await mergeNoGpsPhotos(result.noGpsPhotos);
  placePhotoMarkers(state.photos);

  if (state.activePhoto) {
    const stillExists = state.photos.some(p => p.filePath === state.activePhoto.filePath);
    if (stillExists) setMarkerHighlight(state.activePhoto.filePath, true);
    else closeInfoPanel();
  }

  fitMapToMarkers();
  renderPhotoList();

  const errMsg = result.errors.length ? ` (${result.errors.length} errors)` : '';
  setStatus(`${result.totalScanned} photos scanned · ${result.totalWithGps} with GPS${errMsg}`);
}

export async function mergeNoGpsPhotos(noGpsPhotos) {
  if (!noGpsPhotos?.length) return;
  let dirty = false;
  for (const p of noGpsPhotos) {
    if (!state.meta.photos[p.filePath]) {
      const pm  = getPhotoMeta(p.filePath);
      pm.badGps = true;
      pm.note   = 'No GPS data found in this photo\'s EXIF metadata.';
      dirty = true;
    }
    state.photos.push({ ...p, lat: null, lng: null });
  }
  if (dirty) await saveMetadata();
}

// ─── Folder watching ──────────────────────────────────────────────────────────

export async function watchFolder() {
  await window.photoMap.watchFolder({ folderPath: state.folderPath, recursive: state.recursive });
}

export async function handleFolderChange({ type, filePath }) {
  if (type === 'add') {
    const result = await window.photoMap.scanSingleFile(filePath);
    if (!result.success) { setStatus(`⚠ Could not read new file: ${result.error}`); return; }
    const photoData = result.photo || result.noGps;
    if (photoData) {
      if (result.noGps) {
        await mergeNoGpsPhotos([result.noGps]);
      } else {
        state.photos.push(photoData);
      }
      createPhotoMarker(photoData);
      renderPhotoList();
    }
    setStatus(`${state.photos.filter(p => p.lat != null).length} photos with GPS`);
  } else if (type === 'remove') {
    const idx = state.markers.findIndex(m => m.data.filePath === filePath);
    if (idx !== -1) {
      const { marker, onMap } = state.markers[idx];
      if (marker && onMap) marker.remove();
      state.markers.splice(idx, 1);
      state.photos = state.photos.filter(p => p.filePath !== filePath);
      if (state.meta.photos[filePath]) {
        delete state.meta.photos[filePath];
        await saveMetadata();
      }
      renderPhotoList();
      if (state.activePhoto?.filePath === filePath) closeInfoPanel();
      setStatus(`${state.photos.filter(p => p.lat != null).length} photos with GPS`);
    }
  }
}

// ─── In-place settings apply ──────────────────────────────────────────────────

export async function applyNewSettings({ newApiKey, newFolder, newRecursive, newPinColor,
  apiKeyChanged, folderChanged, recursiveChanged, colorChanged }) {

  closeSettingsPanel();

  const action = classifySettingsChange({ apiKeyChanged, folderChanged, recursiveChanged, colorChanged });

  if (action === 'color-only') {
    state.meta.pinColor = newPinColor;
    state.pinColor      = newPinColor;
    refreshAllMarkerPins();
    renderPhotoList();
    return;
  }

  if (apiKeyChanged) {
    state.apiKey = newApiKey;
    updateTileApiKey(newApiKey);
  }

  state.folderPath = newFolder;
  state.recursive  = newRecursive;
  state.pinColor   = newPinColor;

  await window.photoMap.stopWatching();
  clearPhotoMarkers();
  clearAllLabels();
  state.photos      = [];
  state.activePhoto = null;
  state.meta        = { version: CURRENT_METADATA_VERSION, pinColor: DEFAULT_PIN_COLOR, labels: [], photos: {} };
  closeInfoPanel();
  setFolderName(newFolder);
  renderPhotoList();

  const lockResult = await window.photoMap.acquireLock(newFolder);
  if (!lockResult.success) { showLockError(lockResult, newFolder); return; }

  await loadMetadata();
  renderAllLabels();
  await scanAndDisplay();
  watchFolder();
}

// ─── Lock error screen ────────────────────────────────────────────────────────

export function showLockError(lockResult, _folderPath) {
  if (lockResult.error === 'locked') {
    const lb = lockResult.lockedBy || {};
    el.lockTitle.textContent   = 'Folder In Use';
    el.lockMessage.textContent =
      'Another instance of Photo Map has this folder open for editing. ' +
      'Only one person can edit annotations at a time to prevent data loss.';
    const user    = lb.user    || 'unknown user';
    const machine = lb.machine || 'unknown machine';
    const when    = formatLockTimestamp(lb.timestamp);
    el.lockDetail.textContent = `Opened by: ${user} on ${machine} at ${when}`;
    el.lockDetail.classList.remove('hidden');
  } else if (lockResult.error === 'unwritable') {
    el.lockTitle.textContent   = 'Folder is Read-Only';
    el.lockMessage.textContent =
      'Photo Map cannot save annotations (notes, labels, GPS flags) to this folder. ' +
      'The folder may be on a read-only drive or network share without write permission.';
    el.lockDetail.textContent = lockResult.message || '';
    el.lockDetail.classList.toggle('hidden', !lockResult.message);
  }
  el.lockOverlay.classList.remove('hidden');
  el.appView.classList.add('hidden');
  el.setupScreen.classList.add('hidden');
}

export function hideLockError() { el.lockOverlay.classList.add('hidden'); }

// ─── Folder name display ──────────────────────────────────────────────────────

export function setFolderName(folderPath) {
  if (!folderPath) return;
  const name = folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || folderPath;
  const span = document.getElementById('folder-name');
  if (span) { span.textContent = name; span.title = folderPath; }
}

/*
 * renderer.js — Entry Point & Orchestrator
 *
 * Responsibilities kept here:
 *   - Application init (load settings, wire IPC listeners, decide which screen to show)
 *   - Screen switching (setup ↔ app, lock overlay)
 *   - Setup screen event handling
 *   - Folder scanning and folder-watch callbacks
 *   - Lock-error screen (show / hide)
 *   - All DOM event bindings (wires events to functions in feature modules)
 *
 * Everything else lives in a dedicated module:
 *   state.js       — shared mutable state, DOM refs, constants
 *   metadata.js    — read / write photo-map-data.json
 *   map.js         — Leaflet init, markers, address search
 *   photoList.js   — left sidebar list
 *   infoPanel.js   — right info panel, GPS edit, rename, lightbox, sidebar
 *   labels.js      — map text labels
 *   quickRename.js — full-screen rename mode
 *   settings.js    — settings overlay, export, README viewer
 */

import 'leaflet/dist/leaflet.css';
import { formatLockTimestamp } from '../utils.js';
import { state, el, qrEl, setStatus } from './state.js';
import { loadMetadata, saveMetadata, getPhotoMeta } from './metadata.js';
import { launchMap, placePhotoMarkers, createPhotoMarker, clearPhotoMarkers, fitMapToMarkers, setMarkerHighlight } from './map.js';
import { renderPhotoList } from './photoList.js';
import { closeInfoPanel, navigatePhoto, enterCoordsEditMode, exitCoordsEditMode, handleSaveCoords, handleUndoCoords, handleClearCoordsOverride, handleSaveNote, handleUndoNote, handleBadGpsToggle, handlePhotoPinColorChange, handleResetPinColor, handleRename, handleUndoRename, openLightbox, closeLightbox, handleLightboxWheel, setupLightboxDrag, applySidebarWidth, setupSidebarResize } from './infoPanel.js';
import { renderAllLabels, toggleLabelPlacementMode, handleSaveLabel, handleDeleteLabel, closeLabelPopup, showLabelPopupAtLatLng } from './labels.js';
import { openQuickRename, closeQuickRename } from './quickRename.js';
import { openSettingsPanel, closeSettingsPanel, showSettingsMessage, handleSaveSettings, handleExport, openReadme, closeReadme } from './settings.js';

// ─── Initialization ────────────────────────────────────────────────────────────

async function init() {
  const settings = await window.photoMap.getSettings();
  state.apiKey       = settings.apiKey      || '';
  state.folderPath   = settings.folderPath  || '';
  state.recursive    = settings.recursive   !== false;
  state.sidebarWidth = settings.sidebarWidth || 340;
  state.pinColor     = settings.pinColor    || '#4f8ef7';

  applySidebarWidth(state.sidebarWidth);

  if (window.photoMap.platform === 'darwin') {
    document.body.classList.add('macos');
  }

  window.photoMap.onFolderChanged(handleFolderChange);
  window.photoMap.onOpenSettings(openSettingsPanel);

  window.photoMap.onScanProgress(({ processed, total, withGps }) => {
    setStatus(`Scanning… ${processed} / ${total} files · ${withGps} with GPS`);
  });

  window.addEventListener('offline', () =>
    setStatus('⚠ No network connection — map tiles may not load.')
  );
  window.addEventListener('online', () => setStatus('Network restored.'));

  bindSetupEvents();
  bindAppEvents();

  const skipSetup = sessionStorage.getItem('skipSetup') === '1';
  if (skipSetup) {
    sessionStorage.removeItem('skipSetup');
    if (state.apiKey && state.folderPath) {
      const lockResult = await window.photoMap.acquireLock(state.folderPath);
      if (!lockResult.success) { showLockError(lockResult, state.folderPath); return; }
      showScreen('app');
      setFolderName(state.folderPath);
      startMap();
      return;
    }
  }

  el.apiKeyInput.value     = state.apiKey;
  el.folderPathInput.value = state.folderPath;
  showScreen('setup');
}

// ─── Screen management ─────────────────────────────────────────────────────────

function showScreen(name) {
  el.setupScreen.classList.toggle('hidden', name !== 'setup');
  el.appView.classList.toggle('hidden',     name !== 'app');
  el.lockOverlay.classList.add('hidden');
}

// ─── Setup screen ──────────────────────────────────────────────────────────────

function bindSetupEvents() {
  el.browseBtn.addEventListener('click', async () => {
    const folder = await window.photoMap.pickFolder();
    if (folder) el.folderPathInput.value = folder;
  });
  el.setupContinueBtn.addEventListener('click', handleSetupContinue);
  el.setupReadmeBtn.addEventListener('click', openReadme);
}

async function handleSetupContinue() {
  const apiKey     = el.apiKeyInput.value.trim();
  const folderPath = el.folderPathInput.value.trim();
  if (!apiKey)     { showSetupError('Please enter your MapTiler API key.'); return; }
  if (!folderPath) { showSetupError('Please select your photo folder.');    return; }

  hideSetupError();

  const lockResult = await window.photoMap.acquireLock(folderPath);
  if (!lockResult.success) { showLockError(lockResult, folderPath); return; }

  await window.photoMap.saveSettings({ apiKey, folderPath, recursive: state.recursive });
  state.apiKey = apiKey; state.folderPath = folderPath;
  showScreen('app');
  setFolderName(folderPath);
  startMap();
}

function showSetupError(msg) { el.setupError.textContent = msg; el.setupError.classList.remove('hidden'); }
function hideSetupError()    { el.setupError.classList.add('hidden'); }

// ─── Metadata & Scanning ───────────────────────────────────────────────────────

async function scanAndDisplay() {
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

async function mergeNoGpsPhotos(noGpsPhotos) {
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

// ─── Folder watching ───────────────────────────────────────────────────────────

async function watchFolder() {
  await window.photoMap.watchFolder({ folderPath: state.folderPath, recursive: state.recursive });
}

async function handleFolderChange({ type, filePath }) {
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

// ─── Map launch ────────────────────────────────────────────────────────────────

// Passes callbacks into map.js to break the circular-import chain between
// map.js (needs showLabelPopupAtLatLng from labels.js) and the scan pipeline.
function startMap() {
  launchMap({
    showLabelPopupAtLatLng,
    load: async () => {
      await loadMetadata();
      renderAllLabels();
      await scanAndDisplay();
      watchFolder();
    }
  });
}

// ─── Lock error screen ─────────────────────────────────────────────────────────

function showLockError(lockResult, _folderPath) {
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

function hideLockError() { el.lockOverlay.classList.add('hidden'); }

// ─── Utilities ─────────────────────────────────────────────────────────────────

function setFolderName(folderPath) {
  if (!folderPath) return;
  const name = folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || folderPath;
  const span = document.getElementById('folder-name');
  if (span) { span.textContent = name; span.title = folderPath; }
}

// ─── All event bindings ────────────────────────────────────────────────────────

function bindAppEvents() {

  // Toolbar
  el.toggleListBtn.addEventListener('click', () => {
    el.photoListPanel.classList.toggle('hidden');
    el.toggleListBtn.classList.toggle('active', !el.photoListPanel.classList.contains('hidden'));
    state.map?.invalidateSize();
  });
  el.addLabelBtn.addEventListener('click', toggleLabelPlacementMode);
  el.rescanBtn.addEventListener('click', scanAndDisplay);
  el.settingsBtn.addEventListener('click', openSettingsPanel);
  el.quickRenameBtn.addEventListener('click', openQuickRename);

  // Photo list search & filter buttons
  el.listSearch.addEventListener('input', renderPhotoList);
  document.querySelectorAll('.btn-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.listFilter = btn.dataset.filter;
      renderPhotoList();
    });
  });

  // Info panel
  el.closePanelBtn.addEventListener('click', closeInfoPanel);
  el.prevPhotoBtn.addEventListener('click', () => navigatePhoto(-1));
  el.nextPhotoBtn.addEventListener('click', () => navigatePhoto(1));
  el.renameBtn.addEventListener('click', handleRename);
  el.renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  handleRename();
    if (e.key === 'Escape') closeInfoPanel();
  });
  el.showInFinderBtn.addEventListener('click', () => {
    if (state.activePhoto) window.photoMap.showInFolder(state.activePhoto.filePath);
  });
  el.undoRenameBtn.addEventListener('click', handleUndoRename);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && state.lastRename) {
      e.preventDefault();
      handleUndoRename();
    }
  });
  el.saveNoteBtn.addEventListener('click', handleSaveNote);
  el.undoNoteBtn.addEventListener('click', handleUndoNote);
  el.photoNotes.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveNote();
  });
  el.setCoordsBtn.addEventListener('click', enterCoordsEditMode);
  el.saveCoordsBtn.addEventListener('click', handleSaveCoords);
  el.cancelCoordsBtn.addEventListener('click', exitCoordsEditMode);
  el.undoCoordsBtn.addEventListener('click', handleUndoCoords);
  el.clearCoordsBtn.addEventListener('click', handleClearCoordsOverride);
  el.gpsLatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSaveCoords(); });
  el.gpsLngInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSaveCoords(); });
  el.badGpsCheckbox.addEventListener('change', handleBadGpsToggle);
  el.photoPinColor.addEventListener('change', handlePhotoPinColorChange);
  el.resetPinColorBtn.addEventListener('click', handleResetPinColor);

  // Lightbox
  el.zoomBtn.addEventListener('click', openLightbox);
  el.photoThumbnail.addEventListener('dblclick', openLightbox);
  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => {
    if (e.target === el.lightbox || e.target === el.lightboxCaption) closeLightbox();
  });
  el.lightboxInner.addEventListener('wheel', handleLightboxWheel, { passive: false });
  setupLightboxDrag();

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!el.lightbox.classList.contains('hidden'))      { closeLightbox();    return; }
      if (!el.readmeOverlay.classList.contains('hidden')) { closeReadme();      return; }
      if (!qrEl.overlay.classList.contains('hidden'))     { closeQuickRename(); return; }
      closeInfoPanel();
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (el.infoPanel.classList.contains('hidden'))      return;
      if (!el.lightbox.classList.contains('hidden'))      return;
      if (!qrEl.overlay.classList.contains('hidden'))     return;
      e.preventDefault();
      navigatePhoto(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  // Sidebar resize
  setupSidebarResize();

  // Settings overlay
  el.closeSettingsBtn.addEventListener('click', closeSettingsPanel);
  el.cancelSettingsBtn.addEventListener('click', closeSettingsPanel);
  el.saveSettingsBtn.addEventListener('click', handleSaveSettings);
  el.viewReadmeBtn.addEventListener('click', () => { closeSettingsPanel(); openReadme(); });
  el.settingsBrowseBtn.addEventListener('click', async () => {
    const folder = await window.photoMap.pickFolder();
    if (folder) el.settingsFolder.value = folder;
  });
  el.exportGeoJsonBtn.addEventListener('click', () => handleExport('geojson'));
  el.exportCsvBtn.addEventListener('click',     () => handleExport('csv'));
  el.clearCacheBtn.addEventListener('click', async () => {
    const result = await window.photoMap.clearThumbnailCache();
    showSettingsMessage(
      result.success ? `✓ Cleared ${result.count} thumbnails.` : `Error: ${result.error}`,
      result.success ? 'success' : 'error'
    );
  });
  el.authErrorSettingsLink.addEventListener('click', (e) => { e.preventDefault(); openSettingsPanel(); });
  el.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === el.settingsOverlay) closeSettingsPanel();
  });

  // Label popup
  el.saveLabelBtn.addEventListener('click', handleSaveLabel);
  el.deleteLabelBtn.addEventListener('click', handleDeleteLabel);
  el.closeLabelPopupBtn.addEventListener('click', closeLabelPopup);
  el.labelTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveLabel();
    if (e.key === 'Escape') closeLabelPopup();
  });

  // README viewer
  el.closeReadmeBtn.addEventListener('click', closeReadme);
  el.readmeOverlay.addEventListener('click', (e) => {
    if (e.target === el.readmeOverlay) closeReadme();
  });

  // Lock error overlay
  el.lockRetryBtn.addEventListener('click', async () => {
    const result = await window.photoMap.acquireLock(state.folderPath);
    if (result.success) {
      hideLockError();
      showScreen('app');
      setFolderName(state.folderPath);
      startMap();
    } else {
      showLockError(result, state.folderPath);
    }
  });
  el.lockSettingsBtn.addEventListener('click', () => {
    hideLockError();
    showScreen('setup');
  });
}

// ─── Start ─────────────────────────────────────────────────────────────────────

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection in renderer:', event.reason);
  setStatus(`⚠ Unexpected error: ${event.reason?.message || event.reason}`);
});

document.addEventListener('DOMContentLoaded', init);

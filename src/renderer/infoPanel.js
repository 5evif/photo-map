// ─── Info Panel ───────────────────────────────────────────────────────────────
//
// Opens/closes the right-side photo detail panel, loads thumbnails, manages
// GPS-coordinate editing, notes, bad-GPS flag, per-photo pin color, rename
// (with one-level undo), the zoom lightbox, and the resizable sidebar.

import { getExtension, formatDate, BROWSER_IMAGE_FORMATS } from '../utils.js';
import { state, el } from './state.js';
import { getPhotoMeta, saveMetadata } from './metadata.js';
import { setMarkerHighlight, placeOrMoveMarker, refreshMarkerPin, resolveColor, resolvePhotoDisplayUrl, showPanelMarker, hidePanelMarker } from './map.js';
import { getFilteredPhotos, renderPhotoList, updateNavButtons } from './photoList.js';

// ─── Info panel open / close ──────────────────────────────────────────────────

export async function openInfoPanel(photoData) {
  if (state.activePhoto && state.activePhoto.filePath !== photoData.filePath) {
    const prevPm = getPhotoMeta(state.activePhoto.filePath);
    const currentNote = el.photoNotes.value;
    if (currentNote !== (prevPm.note || '')) {
      prevPm.note = currentNote;
      saveMetadata().then(() => renderPhotoList());
    }
    setMarkerHighlight(state.activePhoto.filePath, false);
    hidePanelMarker();
  }

  state.activePhoto = photoData;
  setMarkerHighlight(photoData.filePath, true);
  showPanelMarker(photoData);
  const pm = getPhotoMeta(photoData.filePath);

  const ext         = getExtension(photoData.filename);
  const nameWithout = photoData.filename.slice(0, -ext.length);

  el.renameInput.value     = nameWithout;
  el.renameExt.textContent = ext;
  el.photoDate.textContent = photoData.date ? formatDate(photoData.date) : 'Not available';

  const effLat = pm.gpsOverride ? pm.gpsOverride.lat : photoData.lat;
  const effLng = pm.gpsOverride ? pm.gpsOverride.lng : photoData.lng;
  el.photoCoords.textContent = (effLat != null && effLng != null)
    ? `${effLat.toFixed(6)}, ${effLng.toFixed(6)}` : 'None';

  el.photoNotes.value        = pm.note    || '';
  el.badGpsCheckbox.checked  = pm.badGps  === true;
  el.photoPinColor.value     = pm.pinColor || resolveColor(photoData.filePath);

  hideRenameMessages();
  el.noteSavedMsg.classList.add('hidden');

  state.lastRename = null;
  el.undoRenameBtn.classList.add('hidden');
  state.lastNote = null;
  el.undoNoteBtn.classList.add('hidden');
  state.lastGpsEdit = null;
  el.undoCoordsBtn.classList.add('hidden');
  el.clearCoordsBtn.classList.toggle('hidden', !pm.gpsOverride);
  exitCoordsEditMode();

  el.infoPanel.classList.remove('hidden');
  el.resizeHandle.classList.remove('hidden');
  requestAnimationFrame(() => state.map?.invalidateSize());
  el.zoomBtn.classList.add('hidden');

  el.photoThumbnail.style.display  = 'none';
  el.thumbnailLoading.style.display = 'flex';

  const expectedPath = photoData.filePath;
  const displayUrl   = await resolvePhotoDisplayUrl(photoData.filePath, photoData.filename);
  if (state.activePhoto?.filePath !== expectedPath) return;

  if (displayUrl) {
    el.photoThumbnail.src          = displayUrl;
    el.photoThumbnail.dataset.url  = displayUrl;
    el.photoThumbnail.style.display = 'block';
    el.zoomBtn.classList.remove('hidden');
  }
  el.thumbnailLoading.style.display = 'none';
  updateNavButtons();
}

export function closeInfoPanel() {
  if (state.activePhoto) setMarkerHighlight(state.activePhoto.filePath, false);
  hidePanelMarker();
  exitCoordsEditMode();
  el.infoPanel.classList.add('hidden');
  el.resizeHandle.classList.add('hidden');
  state.activePhoto = null;
  requestAnimationFrame(() => state.map?.invalidateSize());
  updateNavButtons();
}

export function navigatePhoto(dir) {
  if (!state.activePhoto) return;
  const list = getFilteredPhotos();
  const idx  = list.findIndex(p => p.filePath === state.activePhoto.filePath);
  if (idx === -1) return;
  const next = list[idx + dir];
  if (!next) return;

  const pm     = getPhotoMeta(next.filePath);
  const effLat = pm.gpsOverride ? pm.gpsOverride.lat : next.lat;
  const effLng = pm.gpsOverride ? pm.gpsOverride.lng : next.lng;
  if (effLat != null && effLng != null) {
    state.map.setView([effLat, effLng], Math.max(state.map.getZoom(), 14));
  }

  openInfoPanel(next);

  document.querySelectorAll('.list-row.active').forEach(r => r.classList.remove('active'));
  const row = document.querySelector(`.list-row[data-filepath="${CSS.escape(next.filePath)}"]`);
  if (row) { row.classList.add('active'); row.scrollIntoView({ block: 'nearest' }); }
}

// ─── GPS coordinate editing ───────────────────────────────────────────────────

export function enterCoordsEditMode() {
  if (!state.activePhoto) return;
  const pm  = getPhotoMeta(state.activePhoto.filePath);
  const lat = pm.gpsOverride ? pm.gpsOverride.lat : state.activePhoto.lat;
  const lng = pm.gpsOverride ? pm.gpsOverride.lng : state.activePhoto.lng;
  el.gpsLatInput.value = (lat != null && isFinite(lat)) ? lat.toFixed(6) : '';
  el.gpsLngInput.value = (lng != null && isFinite(lng)) ? lng.toFixed(6) : '';
  el.coordsError.classList.add('hidden');
  el.coordsEditArea.classList.remove('hidden');
  el.setCoordsBtn.classList.add('hidden');
  state.pickingCoords = true;
  state.map?.getContainer().classList.add('cursor-crosshair');
}

export function exitCoordsEditMode() {
  state.pickingCoords = false;
  el.coordsEditArea?.classList.add('hidden');
  el.setCoordsBtn?.classList.remove('hidden');
  state.map?.getContainer().classList.remove('cursor-crosshair');
}

export async function handleSaveCoords() {
  const lat = parseFloat(el.gpsLatInput.value);
  const lng = parseFloat(el.gpsLngInput.value);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    el.coordsError.textContent = 'Enter a valid latitude (−90 to 90) and longitude (−180 to 180).';
    el.coordsError.classList.remove('hidden');
    return;
  }
  el.coordsError.classList.add('hidden');

  const fp    = state.activePhoto.filePath;
  const pm    = getPhotoMeta(fp);
  const entry = state.markers.find(m => m.data.filePath === fp);

  state.lastGpsEdit = {
    filePath: fp,
    prevGpsOverride: pm.gpsOverride ? { ...pm.gpsOverride } : null,
    prevBadGps: pm.badGps === true
  };

  pm.gpsOverride = { lat, lng };
  pm.badGps      = false;

  placeOrMoveMarker(entry, lat, lng);
  setMarkerHighlight(fp, true);

  el.photoCoords.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  el.badGpsCheckbox.checked  = false;
  el.undoCoordsBtn.classList.remove('hidden');
  el.clearCoordsBtn.classList.remove('hidden');
  exitCoordsEditMode();

  await saveMetadata();
  renderPhotoList();
}

export async function handleUndoCoords() {
  if (!state.lastGpsEdit) return;
  const { filePath, prevGpsOverride, prevBadGps } = state.lastGpsEdit;
  if (!state.activePhoto || state.activePhoto.filePath !== filePath) return;

  const pm    = getPhotoMeta(filePath);
  const entry = state.markers.find(m => m.data.filePath === filePath);

  pm.gpsOverride = prevGpsOverride;
  pm.badGps      = prevBadGps;

  const effLat = prevGpsOverride ? prevGpsOverride.lat : entry.data.lat;
  const effLng = prevGpsOverride ? prevGpsOverride.lng : entry.data.lng;

  if (prevBadGps) {
    if (entry.marker && entry.onMap) { entry.marker.remove(); entry.onMap = false; }
  } else {
    placeOrMoveMarker(entry, effLat, effLng);
    setMarkerHighlight(filePath, true);
  }

  el.photoCoords.textContent = (effLat != null && effLng != null)
    ? `${effLat.toFixed(6)}, ${effLng.toFixed(6)}` : 'None';
  el.badGpsCheckbox.checked  = prevBadGps;
  state.lastGpsEdit = null;
  el.undoCoordsBtn.classList.add('hidden');
  el.clearCoordsBtn.classList.toggle('hidden', !prevGpsOverride);

  await saveMetadata();
  renderPhotoList();
}

export async function handleClearCoordsOverride() {
  const fp = state.activePhoto?.filePath;
  if (!fp) return;
  const pm    = getPhotoMeta(fp);
  const entry = state.markers.find(m => m.data.filePath === fp);
  if (!pm.gpsOverride) return;

  state.lastGpsEdit = {
    filePath: fp,
    prevGpsOverride: { ...pm.gpsOverride },
    prevBadGps: pm.badGps === true
  };

  pm.gpsOverride = null;

  const exifLat = entry.data.lat;
  const exifLng = entry.data.lng;

  if (exifLat != null && exifLng != null) {
    placeOrMoveMarker(entry, exifLat, exifLng);
    setMarkerHighlight(fp, true);
    el.photoCoords.textContent = `${exifLat.toFixed(6)}, ${exifLng.toFixed(6)}`;
  } else {
    pm.badGps = true;
    if (entry.marker && entry.onMap) { entry.marker.remove(); entry.onMap = false; }
    el.photoCoords.textContent = 'None';
    el.badGpsCheckbox.checked  = true;
  }

  el.clearCoordsBtn.classList.add('hidden');
  el.undoCoordsBtn.classList.remove('hidden');

  await saveMetadata();
  renderPhotoList();
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function handleSaveNote() {
  if (!state.activePhoto) return;
  const pm = getPhotoMeta(state.activePhoto.filePath);

  state.lastNote = { filePath: state.activePhoto.filePath, previousNote: pm.note || '' };
  el.undoNoteBtn.classList.remove('hidden');

  pm.note = el.photoNotes.value;
  await saveMetadata();

  el.noteSavedMsg.classList.remove('hidden');
  setTimeout(() => el.noteSavedMsg.classList.add('hidden'), 2500);
  renderPhotoList();
}

export async function handleUndoNote() {
  const u = state.lastNote;
  if (!u || !state.activePhoto || state.activePhoto.filePath !== u.filePath) return;

  const pm = getPhotoMeta(u.filePath);
  pm.note = u.previousNote;
  el.photoNotes.value = u.previousNote;
  await saveMetadata();

  state.lastNote = null;
  el.undoNoteBtn.classList.add('hidden');
  el.noteSavedMsg.classList.add('hidden');
  renderPhotoList();
}

// ─── Bad GPS flag ─────────────────────────────────────────────────────────────

export async function handleBadGpsToggle() {
  if (!state.activePhoto) return;
  const pm = getPhotoMeta(state.activePhoto.filePath);
  pm.badGps = el.badGpsCheckbox.checked;
  await saveMetadata();
  refreshMarkerPin(state.activePhoto.filePath);
  hidePanelMarker();
  showPanelMarker(state.activePhoto);
  renderPhotoList();
}

// ─── Per-photo pin color ──────────────────────────────────────────────────────

export async function handlePhotoPinColorChange() {
  if (!state.activePhoto) return;
  const pm = getPhotoMeta(state.activePhoto.filePath);
  pm.pinColor = el.photoPinColor.value;
  await saveMetadata();
  refreshMarkerPin(state.activePhoto.filePath);
  renderPhotoList();
}

export async function handleResetPinColor() {
  if (!state.activePhoto) return;
  const pm = getPhotoMeta(state.activePhoto.filePath);
  pm.pinColor = null;
  await saveMetadata();
  el.photoPinColor.value = resolveColor(state.activePhoto.filePath);
  refreshMarkerPin(state.activePhoto.filePath);
  renderPhotoList();
}

// ─── Rename ───────────────────────────────────────────────────────────────────

export async function handleRename() {
  if (!state.activePhoto) return;
  hideRenameMessages();

  const newNameBase = el.renameInput.value.trim();
  const ext         = el.renameExt.textContent;
  const newName     = newNameBase + ext;

  if (!newNameBase) { showRenameError('Filename cannot be empty.'); return; }

  const result = await window.photoMap.renameFile({
    oldPath:    state.activePhoto.filePath,
    newName,
    folderPath: state.folderPath
  });

  if (!result.success) { showRenameError(result.error); return; }

  const oldPath      = state.activePhoto.filePath;
  const resolvedName = result.newName;
  const resolvedExt  = getExtension(resolvedName);
  const resolvedBase = resolvedName.slice(0, -resolvedExt.length);

  state.lastRename = {
    oldPath,
    oldName:      state.activePhoto.filename,
    newPath:      result.newPath,
    newName:      resolvedName,
    metaSnapshot: state.meta.photos[oldPath]
      ? JSON.parse(JSON.stringify(state.meta.photos[oldPath]))
      : null
  };
  el.undoRenameBtn.classList.remove('hidden');

  state.activePhoto.filePath = result.newPath;
  state.activePhoto.filename = resolvedName;

  if (state.meta.photos[oldPath] !== undefined) {
    state.meta.photos[result.newPath] = state.meta.photos[oldPath];
    delete state.meta.photos[oldPath];
  }
  await saveMetadata();

  const markerEntry = state.markers.find(m => m.data.filePath === oldPath);
  if (markerEntry) {
    markerEntry.data.filePath = result.newPath;
    markerEntry.data.filename = resolvedName;
    if (markerEntry.marker) markerEntry.marker.options.title = resolvedName;
  }

  const photoEntry = state.photos.find(p => p.filePath === oldPath);
  if (photoEntry) { photoEntry.filePath = result.newPath; photoEntry.filename = resolvedName; }

  el.renameInput.value     = resolvedBase;
  el.renameExt.textContent = resolvedExt;

  renderPhotoList();
  showRenameSuccess(resolvedName !== newName ? `✓ Renamed to "${resolvedName}"` : '✓ Renamed');
}

function showRenameError(msg)  { el.renameError.textContent = msg; el.renameError.classList.remove('hidden'); }
function hideRenameMessages()  { el.renameError.classList.add('hidden'); el.renameSuccess.classList.add('hidden'); }
function showRenameSuccess(msg = '✓ Renamed') {
  el.renameSuccess.textContent = msg;
  el.renameSuccess.classList.remove('hidden');
  setTimeout(() => el.renameSuccess.classList.add('hidden'), 3000);
}

// ─── Undo rename ──────────────────────────────────────────────────────────────

export async function handleUndoRename() {
  const u = state.lastRename;
  if (!u) return;

  hideRenameMessages();

  const result = await window.photoMap.renameFile({
    oldPath:    u.newPath,
    newName:    u.oldName,
    folderPath: state.folderPath
  });

  if (!result.success) {
    state.lastRename = null;
    el.undoRenameBtn.classList.add('hidden');
    showRenameError(`Undo failed: ${result.error}`);
    return;
  }

  if (u.metaSnapshot !== null) {
    state.meta.photos[u.oldPath] = u.metaSnapshot;
  }
  delete state.meta.photos[u.newPath];
  await saveMetadata();

  if (state.activePhoto?.filePath === u.newPath) {
    state.activePhoto.filePath = u.oldPath;
    state.activePhoto.filename = u.oldName;
    el.renameInput.value      = u.oldName.slice(0, -getExtension(u.oldName).length);
    el.renameExt.textContent  = getExtension(u.oldName);
  }

  const markerEntry = state.markers.find(m => m.data.filePath === u.newPath);
  if (markerEntry) {
    markerEntry.data.filePath = u.oldPath;
    markerEntry.data.filename = u.oldName;
    if (markerEntry.marker) markerEntry.marker.options.title = u.oldName;
  }

  const photoEntry = state.photos.find(p => p.filePath === u.newPath);
  if (photoEntry) { photoEntry.filePath = u.oldPath; photoEntry.filename = u.oldName; }

  state.lastRename = null;
  el.undoRenameBtn.classList.add('hidden');

  renderPhotoList();
  showRenameSuccess('↩ Undone');
}

// ─── Lightbox (photo zoom) ────────────────────────────────────────────────────

export function openLightbox() {
  if (!state.activePhoto) return;
  const ext = getExtension(state.activePhoto.filename).toLowerCase();
  const url = BROWSER_IMAGE_FORMATS.has(ext)
    ? window.photoMap.filePathToUrl(state.activePhoto.filePath)
    : el.photoThumbnail.dataset.url;
  if (!url) return;

  el.lightboxImg.src             = url;
  el.lightboxCaption.textContent = state.activePhoto.filename;
  state.lightboxScale            = 1;
  state.lightboxOrigin           = { x: 0, y: 0 };
  applyLightboxTransform();

  el.lightbox.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

export function closeLightbox() {
  el.lightbox.classList.add('hidden');
  el.lightbox.classList.remove('above-qr');
  document.body.style.overflow = '';
  el.lightboxImg.src = '';
}

export function applyLightboxTransform() {
  el.lightboxImg.style.transform =
    `translate(${state.lightboxOrigin.x}px, ${state.lightboxOrigin.y}px) scale(${state.lightboxScale})`;
}

export function handleLightboxWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.85 : 1.18;
  state.lightboxScale = Math.min(10, Math.max(0.5, state.lightboxScale * delta));
  applyLightboxTransform();
}

export function setupLightboxDrag() {
  let dragging = false;
  let startX = 0, startY = 0;
  let originX = 0, originY = 0;

  el.lightboxInner.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    originX = state.lightboxOrigin.x; originY = state.lightboxOrigin.y;
    el.lightboxInner.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    state.lightboxOrigin.x = originX + (e.clientX - startX);
    state.lightboxOrigin.y = originY + (e.clientY - startY);
    applyLightboxTransform();
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    el.lightboxInner.style.cursor = 'grab';
  });

  el.lightboxInner.addEventListener('click', (e) => {
    const r = el.lightboxImg.getBoundingClientRect();
    const onPhoto = e.clientX >= r.left && e.clientX <= r.right &&
                    e.clientY >= r.top  && e.clientY <= r.bottom;
    if (!onPhoto) closeLightbox();
  });
}

// ─── Resizable sidebar ────────────────────────────────────────────────────────

export function applySidebarWidth(w) {
  const clamped = Math.min(600, Math.max(260, w));
  state.sidebarWidth = clamped;
  el.infoPanel.style.width    = clamped + 'px';
  el.resizeHandle.style.right = clamped + 'px';
}

export function setupSidebarResize() {
  let startX = 0;
  let startW = 0;

  el.resizeHandle.addEventListener('mousedown', (e) => {
    state.isResizing = true;
    startX = e.clientX;
    startW = state.sidebarWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor     = 'ew-resize';
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.isResizing) return;
    const delta = startX - e.clientX;
    applySidebarWidth(startW + delta);
    state.map?.invalidateSize();
  });

  window.addEventListener('mouseup', () => {
    if (!state.isResizing) return;
    state.isResizing = false;
    document.body.style.userSelect = '';
    document.body.style.cursor     = '';
    window.photoMap.saveSettings({ sidebarWidth: state.sidebarWidth });
  });
}

// Called once by renderer.js during bindAppEvents().
export function registerInfoPanelEvents() {
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

  // Sidebar resize
  setupSidebarResize();
}

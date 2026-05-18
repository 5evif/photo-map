// ─── Quick Rename ─────────────────────────────────────────────────────────────
//
// Full-screen two-column mode for fast sequential photo renaming.
//   Left  — mini satellite map + notes + bad-GPS toggle
//   Right — large photo thumbnail + rename bar
//
// Keyboard: Enter = save & next | Tab = toggle bad GPS
//           Cmd/Ctrl+Enter = save note only | Esc = exit (global handler)

import L from 'leaflet';
import { escapeHtml, getExtension, BROWSER_IMAGE_FORMATS } from '../utils.js';
import { state, el, qr, qrEl, setStatus, LABEL_FONT_SIZES, MAPTILER_ATTRIBUTION } from './state.js';
import { getPhotoMeta, saveMetadata } from './metadata.js';
import { resolvePhotoDisplayUrl, refreshMarkerPin, resolveColor, createPinIcon } from './map.js';
import { renderPhotoList } from './photoList.js';
import { openInfoPanel, applyLightboxTransform } from './infoPanel.js';

export function openQuickRename() {
  if (!state.photos.length) { setStatus('No photos to rename.'); return; }

  qr.photos = [...state.photos]
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }));

  qr.index   = 0;
  qr.loading = false;

  qrEl.overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  if (!qr.miniMap) {
    qr.miniMap = L.map(qrEl.mapDiv, {
      zoom: 18, center: [20, 0], zoomControl: false, attributionControl: true
    });
    L.tileLayer(
      `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=${state.apiKey}`,
      { tileSize: 512, zoomOffset: -1, maxZoom: 22, attribution: MAPTILER_ATTRIBUTION, crossOrigin: true }
    ).addTo(qr.miniMap);
  }

  for (const m of qr.miniMapLabels) m.remove();
  qr.miniMapLabels = [];

  for (const { labelData } of state.labelMarkers) {
    const fontSize = LABEL_FONT_SIZES[labelData.size] || '16px';
    const m = L.marker([labelData.lat, labelData.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="map-label" style="font-size:${fontSize}">${escapeHtml(labelData.text)}</div>`,
        iconSize: null, iconAnchor: [0, 0]
      })
    }).addTo(qr.miniMap);
    qr.miniMapLabels.push(m);
  }

  qr.miniMap.invalidateSize();

  if (!qrEl.overlay.dataset.bound) {
    qrEl.closeBtn.addEventListener('click', closeQuickRename);
    qrEl.saveBtn.addEventListener('click', qrSaveAndNext);
    qrEl.skipBtn.addEventListener('click', qrSkip);
    qrEl.undoBtn.addEventListener('click', qrUndo);
    qrEl.zoomBtn.addEventListener('click', qrOpenZoom);
    qrEl.img.addEventListener('dblclick', qrOpenZoom);
    qrEl.saveNoteBtn.addEventListener('click', qrSaveNote);
    qrEl.undoNoteBtn.addEventListener('click', qrUndoNote);
    qrEl.badGpsChk.addEventListener('change', qrToggleBadGps);

    qrEl.badGpsLabel.addEventListener('click', (e) => {
      if (e.target !== qrEl.badGpsChk) {
        qrEl.badGpsChk.checked = !qrEl.badGpsChk.checked;
        qrToggleBadGps();
      }
    });

    qrEl.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); qrSaveAndNext(); }
      if (e.key === 'Tab')   { e.preventDefault(); qrEl.badGpsChk.checked = !qrEl.badGpsChk.checked; qrToggleBadGps(); }
    });

    qrEl.notes.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); qrSaveNote(); return; }
      if (e.key === 'Enter') { e.preventDefault(); qrSaveAndNext(); }
      if (e.key === 'Tab')   { e.preventDefault(); qrEl.badGpsChk.checked = !qrEl.badGpsChk.checked; qrToggleBadGps(); }
    });

    qrEl.overlay.dataset.bound = 'true';
  }

  qrLoadPhoto(0);
}

async function qrLoadPhoto(idx) {
  if (idx >= qr.photos.length) {
    closeQuickRename();
    setStatus(`Quick Rename complete — ${qr.photos.length} photos reviewed.`);
    return;
  }

  qr.index   = idx;
  qr.loading = true;

  const photo = qr.photos[idx];
  const pm    = getPhotoMeta(photo.filePath);
  const ext   = getExtension(photo.filename);
  const base  = photo.filename.slice(0, -ext.length);

  qrEl.counter.textContent = `${idx + 1} / ${qr.photos.length}`;

  qrEl.error.classList.add('hidden');
  qrEl.nameInput.value     = base;
  qrEl.extSpan.textContent = ext;

  qrEl.notes.value = pm.note || '';
  qrEl.noteSaved.classList.add('hidden');
  qrEl.undoNoteBtn.classList.add('hidden');
  qr.lastNoteState = null;

  qrEl.badGpsChk.checked = pm.badGps === true;
  qrEl.badGpsLabel.classList.toggle('is-flagged', pm.badGps === true);

  const effLat = pm.gpsOverride ? pm.gpsOverride.lat : photo.lat;
  const effLng = pm.gpsOverride ? pm.gpsOverride.lng : photo.lng;
  qrEl.coords.textContent = (effLat != null && effLng != null)
    ? `${effLat.toFixed(5)}, ${effLng.toFixed(5)}`
    : 'No GPS data';

  if (qr.miniMap) {
    if (effLat != null && effLng != null) {
      const pos = [effLat, effLng];
      qr.miniMap.setView(pos, 18, { animate: false });
      if (qr.miniMarker) {
        qr.miniMarker.setLatLng(pos);
        qr.miniMarker.setIcon(createPinIcon(resolveColor(photo.filePath)));
      } else {
        qr.miniMarker = L.marker(pos, { icon: createPinIcon(resolveColor(photo.filePath)) }).addTo(qr.miniMap);
      }
    } else {
      if (qr.miniMarker) { qr.miniMarker.remove(); qr.miniMarker = null; }
    }
  }

  qrEl.img.style.opacity     = '0';
  qrEl.zoomBtn.classList.add('hidden');
  qrEl.loading.style.display = 'flex';
  qrEl.loading.textContent   = 'Loading…';

  const qrUrl = await resolvePhotoDisplayUrl(photo.filePath, photo.filename);

  if (qr.index !== idx) return;

  if (qrUrl) {
    qrEl.img.dataset.url = qrUrl;
    qrEl.img.onload = () => {
      qrEl.img.style.opacity     = '1';
      qrEl.loading.style.display = 'none';
      qrEl.zoomBtn.classList.remove('hidden');
      qr.loading = false;
    };
    qrEl.img.src = qrUrl;
  } else {
    qrEl.loading.textContent = 'No preview available';
    qr.loading = false;
  }

  qrEl.nameInput.focus();
  qrEl.nameInput.select();
}

async function qrSaveNote() {
  const photo = qr.photos[qr.index];
  if (!photo) return;
  const pm       = getPhotoMeta(photo.filePath);
  const prevNote = pm.note || '';
  pm.note        = qrEl.notes.value;
  await saveMetadata();

  qr.lastNoteState = { prevNote };
  qrEl.undoNoteBtn.classList.remove('hidden');

  qrEl.noteSaved.classList.remove('hidden');
  setTimeout(() => qrEl.noteSaved.classList.add('hidden'), 2000);
  renderPhotoList();
}

async function qrUndoNote() {
  const photo = qr.photos[qr.index];
  if (!photo) return;
  const prevNote = qr.lastNoteState?.prevNote ?? '';
  const pm       = getPhotoMeta(photo.filePath);
  pm.note        = prevNote;
  qrEl.notes.value = prevNote;
  await saveMetadata();
  qrEl.undoNoteBtn.classList.add('hidden');
  qrEl.noteSaved.classList.add('hidden');
  renderPhotoList();
}

async function qrToggleBadGps() {
  const photo = qr.photos[qr.index];
  if (!photo) return;
  const pm = getPhotoMeta(photo.filePath);
  pm.badGps = qrEl.badGpsChk.checked;
  qrEl.badGpsLabel.classList.toggle('is-flagged', pm.badGps);
  await saveMetadata();
  refreshMarkerPin(photo.filePath);
  renderPhotoList();
}

async function qrFlushNote() {
  const photo = qr.photos[qr.index];
  if (!photo) return;

  qr.lastState = {
    index:        qr.index,
    filePath:     photo.filePath,
    filename:     photo.filename,
    metaSnapshot: state.meta.photos[photo.filePath]
      ? JSON.parse(JSON.stringify(state.meta.photos[photo.filePath]))
      : null,
    noteText:     qrEl.notes.value
  };
  if (qr.index > 0) qrEl.undoBtn.classList.remove('hidden');

  const pm          = getPhotoMeta(photo.filePath);
  const currentNote = qrEl.notes.value;
  if (currentNote !== (pm.note || '')) {
    pm.note = currentNote;
    await saveMetadata();
    renderPhotoList();
  }
}

async function qrSaveAndNext() {
  if (qr.loading) return;

  const photo   = qr.photos[qr.index];
  const ext     = qrEl.extSpan.textContent;
  const newBase = qrEl.nameInput.value.trim();
  const newName = newBase + ext;

  qrEl.error.classList.add('hidden');
  await qrFlushNote();

  if (newName === photo.filename) { qrLoadPhoto(qr.index + 1); return; }

  if (!newBase) {
    qrEl.error.textContent = 'Filename cannot be empty.';
    qrEl.error.classList.remove('hidden');
    return;
  }

  const result = await window.photoMap.renameFile({
    oldPath: photo.filePath, newName, folderPath: state.folderPath
  });

  if (!result.success) {
    qrEl.error.textContent = result.error;
    qrEl.error.classList.remove('hidden');
    return;
  }

  const resolvedName = result.newName;

  if (state.meta.photos[photo.filePath] !== undefined) {
    state.meta.photos[result.newPath] = state.meta.photos[photo.filePath];
    delete state.meta.photos[photo.filePath];
  }
  await saveMetadata();

  const sp = state.photos.find(p => p.filePath === photo.filePath);
  if (sp) { sp.filePath = result.newPath; sp.filename = resolvedName; }

  const me = state.markers.find(m => m.data.filePath === photo.filePath);
  if (me) {
    me.data.filePath = result.newPath; me.data.filename = resolvedName;
    if (me.marker) me.marker.options.title = resolvedName;
  }

  photo.filePath = result.newPath;
  photo.filename = resolvedName;

  const resolvedExt      = getExtension(resolvedName);
  qrEl.nameInput.value   = resolvedName.slice(0, -resolvedExt.length);
  qrEl.extSpan.textContent = resolvedExt;

  renderPhotoList();
  qrLoadPhoto(qr.index + 1);
}

async function qrSkip() {
  if (qr.loading) return;
  qrEl.error.classList.add('hidden');
  await qrFlushNote();
  qrLoadPhoto(qr.index + 1);
}

async function qrUndo() {
  const u = qr.lastState;
  if (!u) return;

  const prevPhoto = qr.photos[u.index];
  if (!prevPhoto) return;

  qrEl.error.classList.add('hidden');

  if (prevPhoto.filePath !== u.filePath) {
    const result = await window.photoMap.renameFile({
      oldPath:    prevPhoto.filePath,
      newName:    u.filename,
      folderPath: state.folderPath
    });
    if (!result.success) {
      qrEl.error.textContent = `Undo failed: ${result.error}`;
      qrEl.error.classList.remove('hidden');
      qr.lastState = null;
      qrEl.undoBtn.classList.add('hidden');
      return;
    }
    if (state.meta.photos[prevPhoto.filePath] !== undefined) {
      state.meta.photos[u.filePath] = state.meta.photos[prevPhoto.filePath];
      delete state.meta.photos[prevPhoto.filePath];
    }
    const sp = state.photos.find(p => p.filePath === prevPhoto.filePath);
    if (sp) { sp.filePath = u.filePath; sp.filename = u.filename; }
    const me = state.markers.find(m => m.data.filePath === prevPhoto.filePath);
    if (me) { me.data.filePath = u.filePath; me.data.filename = u.filename; }
    prevPhoto.filePath = u.filePath;
    prevPhoto.filename = u.filename;
  }

  if (u.metaSnapshot !== null) {
    state.meta.photos[u.filePath] = u.metaSnapshot;
  } else {
    delete state.meta.photos[u.filePath];
  }
  await saveMetadata();
  renderPhotoList();

  qr.lastState = null;
  qrEl.undoBtn.classList.add('hidden');
  qrLoadPhoto(u.index);
}

function qrOpenZoom() {
  const photo = qr.photos[qr.index];
  if (!photo) return;
  const ext = getExtension(photo.filename).toLowerCase();
  const url = BROWSER_IMAGE_FORMATS.has(ext)
    ? window.photoMap.filePathToUrl(photo.filePath)
    : (qrEl.img.dataset.url || '');
  if (!url) return;
  el.lightboxImg.src             = url;
  el.lightboxCaption.textContent = photo.filename;
  state.lightboxScale            = 1;
  state.lightboxOrigin           = { x: 0, y: 0 };
  applyLightboxTransform();
  el.lightbox.classList.add('above-qr');
  el.lightbox.classList.remove('hidden');
}

export function closeQuickRename() {
  qrEl.overlay.classList.add('hidden');
  document.body.style.overflow = '';
  qrEl.img.src         = '';
  qrEl.img.dataset.url = '';
  if (state.activePhoto) openInfoPanel(state.activePhoto);
}

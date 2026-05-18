// ─── Photo List (left sidebar) ────────────────────────────────────────────────
//
// Renders the scrollable, searchable, filterable photo list.  Also owns the
// filter-to-marker synchronisation (applyMarkerFilter) and the ←/→ nav-button
// enabled state (updateNavButtons).

import { escapeHtml } from '../utils.js';
import { state, el } from './state.js';
import { getPhotoMeta } from './metadata.js';
import { openInfoPanel } from './infoPanel.js';

export function formatDateShort(isoString) {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch { return escapeHtml(String(isoString)); }
}

export function getFilteredPhotos() {
  const query = (el.listSearch.value || '').toLowerCase();
  return [...state.photos]
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }))
    .filter(photo => {
      if (query && !photo.filename.toLowerCase().includes(query)) return false;
      const pm = getPhotoMeta(photo.filePath);
      if (state.listFilter === 'bad'      && !pm.badGps)        return false;
      if (state.listFilter === 'note'     && !pm.note?.trim())   return false;
      if (state.listFilter === 'override' && !pm.gpsOverride)    return false;
      return true;
    });
}

export function renderPhotoList() {
  const filtered = getFilteredPhotos();

  el.photoListItems.innerHTML = '';
  const visiblePaths = new Set();

  for (const photo of filtered) {
    visiblePaths.add(photo.filePath);

    const pm          = getPhotoMeta(photo.filePath);
    const isBad       = pm.badGps === true;
    const hasNote     = !!(pm.note && pm.note.trim().length > 0);
    const hasOverride = !!pm.gpsOverride;

    const row = document.createElement('div');
    row.className    = 'list-row' + (state.activePhoto?.filePath === photo.filePath ? ' active' : '');
    row.dataset.filepath = photo.filePath;

    row.innerHTML = `
      <div class="list-row-name">
        ${isBad       ? '<span class="badge badge-warn"     title="GPS flagged as incorrect">⚠</span>' : ''}
        ${hasNote     ? '<span class="badge badge-note"     title="Has a note">📝</span>' : ''}
        ${hasOverride ? '<span class="badge badge-override" title="GPS coordinates manually set">✎</span>' : ''}
        <span class="list-filename">${escapeHtml(photo.filename)}</span>
      </div>
      <div class="list-row-date">${photo.date ? formatDateShort(photo.date) : '—'}</div>
    `;

    row.addEventListener('click', () => {
      const pm     = getPhotoMeta(photo.filePath);
      const effLat = pm.gpsOverride ? pm.gpsOverride.lat : photo.lat;
      const effLng = pm.gpsOverride ? pm.gpsOverride.lng : photo.lng;
      if (effLat != null && effLng != null) {
        state.map.setView([effLat, effLng], Math.max(state.map.getZoom(), 14));
      }
      openInfoPanel(photo);
      document.querySelectorAll('.list-row.active').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    });

    el.photoListItems.appendChild(row);
  }

  if (!el.photoListItems.children.length) {
    el.photoListItems.innerHTML = '<p class="list-empty">No photos match your search.</p>';
  }

  applyMarkerFilter(visiblePaths);
  updateNavButtons();
}

export function applyMarkerFilter(visiblePaths) {
  if (!state.map) return;
  for (const entry of state.markers) {
    if (!entry.marker) continue;
    const shouldShow = entry.onMap && visiblePaths.has(entry.data.filePath);
    const isOnMap    = state.map.hasLayer(entry.marker);
    if (shouldShow && !isOnMap)  entry.marker.addTo(state.map);
    if (!shouldShow && isOnMap)  entry.marker.remove();
  }
}

export function updateNavButtons() {
  if (!state.activePhoto) {
    el.prevPhotoBtn.disabled = true;
    el.nextPhotoBtn.disabled = true;
    return;
  }
  const list = getFilteredPhotos();
  const idx  = list.findIndex(p => p.filePath === state.activePhoto.filePath);
  el.prevPhotoBtn.disabled = idx <= 0;
  el.nextPhotoBtn.disabled = idx === -1 || idx >= list.length - 1;
}

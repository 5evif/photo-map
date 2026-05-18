// ─── Photo List (left sidebar) ────────────────────────────────────────────────
//
// Renders the scrollable, searchable, filterable photo list.  Uses virtual
// scrolling for lists larger than VIRTUAL_THRESHOLD to avoid creating thousands
// of DOM nodes on every render cycle.
//
// Virtual scroll contract: .list-row must be exactly ROW_HEIGHT px tall.
// The CSS enforces this with `height: 56px; box-sizing: border-box; overflow: hidden`.

import { escapeHtml, formatDateShort, filterAndSortPhotos } from '../utils.js';
import { state, el } from './state.js';
import { getPhotoMeta } from './metadata.js';
import { openInfoPanel } from './infoPanel.js';

const ROW_HEIGHT        = 56;  // px — must match .list-row height in styles.css
const VIRTUAL_THRESHOLD = 150; // items below this are rendered normally
const OVERSCAN          = 5;   // extra rows above and below the visible window

// ─── Module-level virtual-scroll state ───────────────────────────────────────

let _allFiltered     = []; // the current filtered photo array
let _railEl          = null;  // the fixed-height container for virtual rows
let _scrollBound     = false; // true once the scroll listener is attached
let _scrollRafPending = false; // true while a RAF for scroll is queued

function _onScroll() {
  if (_scrollRafPending) return;
  _scrollRafPending = true;
  requestAnimationFrame(() => { _scrollRafPending = false; _renderVirtualWindow(); });
}

// ─── Filter ───────────────────────────────────────────────────────────────────

export function getFilteredPhotos() {
  const query = (el.listSearch.value || '').toLowerCase();
  return filterAndSortPhotos(state.photos, query, state.listFilter, getPhotoMeta);
}

// ─── Row builder ──────────────────────────────────────────────────────────────

function _buildRow(photo) {
  const pm          = getPhotoMeta(photo.filePath);
  const isBad       = pm.badGps === true;
  const hasNote     = !!(pm.note && pm.note.trim().length > 0);
  const hasOverride = !!pm.gpsOverride;

  const row = document.createElement('div');
  row.className        = 'list-row' + (state.activePhoto?.filePath === photo.filePath ? ' active' : '');
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
    const pm2    = getPhotoMeta(photo.filePath);
    const effLat = pm2.gpsOverride ? pm2.gpsOverride.lat : photo.lat;
    const effLng = pm2.gpsOverride ? pm2.gpsOverride.lng : photo.lng;
    if (effLat != null && effLng != null) {
      state.map.setView([effLat, effLng], Math.max(state.map.getZoom(), 14));
    }
    openInfoPanel(photo);
    document.querySelectorAll('.list-row.active').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
  });

  return row;
}

// ─── Virtual scroll window render ─────────────────────────────────────────────

function _renderVirtualWindow() {
  if (!_railEl || !_allFiltered.length) return;

  const scrollTop    = el.photoListItems.scrollTop;
  const clientHeight = el.photoListItems.clientHeight;

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx   = Math.min(
    _allFiltered.length,
    Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN
  );

  _railEl.innerHTML = '';

  for (let i = startIdx; i < endIdx; i++) {
    const row      = _buildRow(_allFiltered[i]);
    row.style.position = 'absolute';
    row.style.top      = (i * ROW_HEIGHT) + 'px';
    row.style.left     = '0';
    row.style.right    = '0';
    row.style.height   = ROW_HEIGHT + 'px';
    _railEl.appendChild(row);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function renderPhotoList() {
  const filtered     = getFilteredPhotos();
  const savedScrollTop = el.photoListItems.scrollTop;

  _allFiltered = filtered;
  _railEl      = null;
  el.photoListItems.innerHTML = '';

  const visiblePaths = new Set(filtered.map(p => p.filePath));
  applyMarkerFilter(visiblePaths);
  updateNavButtons();

  if (!filtered.length) {
    el.photoListItems.innerHTML = '<p class="list-empty">No photos match your search.</p>';
    return;
  }

  if (filtered.length <= VIRTUAL_THRESHOLD) {
    // Small list — render all rows in normal document flow.
    for (const photo of filtered) {
      el.photoListItems.appendChild(_buildRow(photo));
    }
    el.photoListItems.scrollTop = Math.min(savedScrollTop, el.photoListItems.scrollHeight);
    return;
  }

  // Large list — virtual scroll: only render the visible window.
  _railEl = document.createElement('div');
  _railEl.style.cssText = `position:relative; height:${filtered.length * ROW_HEIGHT}px;`;
  el.photoListItems.appendChild(_railEl);

  // Attach the scroll listener once; RAF-throttled to avoid firing on every pixel.
  if (!_scrollBound) {
    el.photoListItems.addEventListener('scroll', _onScroll, { passive: true });
    _scrollBound = true;
  }

  el.photoListItems.scrollTop = Math.min(savedScrollTop, el.photoListItems.scrollHeight);
  _renderVirtualWindow();
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

// Called once by renderer.js during bindAppEvents().
export function registerPhotoListEvents() {
  let _searchTimer = null;
  el.listSearch.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(renderPhotoList, 150);
  });
  document.querySelectorAll('.btn-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.listFilter = btn.dataset.filter;
      renderPhotoList();
    });
  });
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

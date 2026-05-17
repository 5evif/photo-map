// ─── Leaflet Map, Markers & Address Search ────────────────────────────────────
//
// Owns the Leaflet map instance, tile layers, and photo pin markers.
// `refreshMarkerPin` intentionally does NOT call renderPhotoList — callers
// handle their own follow-up UI updates.

import L from 'leaflet';
import { sanitizeColor, BROWSER_IMAGE_FORMATS } from '../utils.js';
import { state, el, setStatus, MAPTILER_ATTRIBUTION } from './state.js';
import { getPhotoMeta } from './metadata.js';
import { openInfoPanel } from './infoPanel.js';

// ─── Auth error banner ────────────────────────────────────────────────────────

export function showAuthError(status = 0) {
  const quotaExceeded = status === 429;
  el.authErrorTitle.textContent = quotaExceeded
    ? '⚠ MapTiler request limit reached — free tier quota exceeded.'
    : '⚠ MapTiler API key error — map tiles failed to load.';
  el.authErrorKeyDetail.classList.toggle('hidden', quotaExceeded);
  el.authErrorQuotaDetail.classList.toggle('hidden', !quotaExceeded);
  el.authErrorBanner.classList.remove('hidden');
}

// ─── Map initialisation ───────────────────────────────────────────────────────
//
// `callbacks` is an object of functions that map.js needs but that live in
// other modules, passed in from renderer.js to break the circular dependency:
//   callbacks.showLabelPopupAtLatLng(latLng) — labels.js
//   callbacks.load()                          — async: loadMetadata + renderAllLabels + scan + watch

export async function initMap(callbacks) {
  if (state.map) return;

  state.map = L.map('map', { center: [20, 0], zoom: 2, zoomControl: false });

  state.satelliteLayer = L.tileLayer(
    `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=${state.apiKey}`,
    { tileSize: 512, zoomOffset: -1, maxZoom: 20, attribution: MAPTILER_ATTRIBUTION, crossOrigin: true }
  );

  state.streetsLayer = L.tileLayer(
    `https://api.maptiler.com/maps/openstreetmap/{z}/{x}/{y}.png?key=${state.apiKey}`,
    { maxZoom: 19, attribution: MAPTILER_ATTRIBUTION, crossOrigin: true }
  );

  state.satelliteLayer.addTo(state.map);
  L.control.layers(
    { 'Satellite': state.satelliteLayer, 'OpenStreetMap': state.streetsLayer },
    null, { position: 'topright' }
  ).addTo(state.map);
  L.control.zoom({ position: 'topright' }).addTo(state.map);

  let authErrorShown = false;
  [state.satelliteLayer, state.streetsLayer].forEach(layer => {
    layer.on('tileerror', (e) => {
      if (authErrorShown) return;
      authErrorShown = true;
      const src = e.tile?.src;
      if (src) {
        window.photoMap.checkTileStatus(src).then(({ status }) => showAuthError(status));
      } else {
        showAuthError();
      }
    });
  });

  state.map.on('click', (e) => {
    if (state.placingLabel) { callbacks.showLabelPopupAtLatLng(e.latlng); return; }
    if (state.pickingCoords) {
      el.gpsLatInput.value = e.latlng.lat.toFixed(6);
      el.gpsLngInput.value = e.latlng.lng.toFixed(6);
    }
  });

  addAddressSearch();
  await callbacks.load();
}

export function launchMap(callbacks) {
  initMap(callbacks).catch(err => {
    console.error('Map init failed:', err);
    setStatus('⚠ Map failed to load: ' + err.message);
  });
}

// Updates the MapTiler API key in the tile layer URLs without reinitialising
// the map — called when the user changes only the API key in Settings.
export function updateTileApiKey(newKey) {
  state.satelliteLayer?.setUrl(
    `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=${newKey}`
  );
  state.streetsLayer?.setUrl(
    `https://api.maptiler.com/maps/openstreetmap/{z}/{x}/{y}.png?key=${newKey}`
  );
}

// Re-colours every on-map marker pin to reflect the current global/per-photo
// pin color.  Called when the user changes the global pin color in Settings.
export function refreshAllMarkerPins() {
  for (const entry of state.markers) {
    if (!entry.marker) continue;
    entry.marker.setIcon(createPinIcon(resolveColor(entry.data.filePath)));
  }
}

// ─── Address geocoding search control ─────────────────────────────────────────

function addAddressSearch() {
  const AddressSearch = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const container = L.DomUtil.create('div', 'address-search');
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      const row      = L.DomUtil.create('div', 'address-search-row', container);
      const input    = L.DomUtil.create('input', 'address-search-input', row);
      input.type        = 'text';
      input.placeholder = 'Search address…';
      input.setAttribute('aria-label', 'Search for an address');

      const btn       = L.DomUtil.create('button', 'btn address-search-btn', row);
      btn.title        = 'Search';
      btn.textContent  = '⌕';

      const dropdown  = L.DomUtil.create('div', 'address-results hidden', container);

      let searchMarker = null;

      function clearMarker() {
        if (searchMarker) { searchMarker.remove(); searchMarker = null; }
      }

      function closeDropdown() {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
      }

      function showResult(feature) {
        closeDropdown();
        const [lng, lat] = feature.center;
        clearMarker();
        const icon = L.divIcon({
          className: '',
          html: '<div class="search-result-pin"></div>',
          iconSize: [14, 14], iconAnchor: [7, 7]
        });
        searchMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(state.map);
        state.map.setView([lat, lng], 13);
        input.value = feature.place_name;
      }

      async function doSearch() {
        const query = input.value.trim();
        if (!query) return;
        closeDropdown();
        btn.disabled = true;
        try {
          const url  = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${state.apiKey}&limit=5`;
          const res  = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data     = await res.json();
          const features = data.features || [];
          if (!features.length) {
            const item = L.DomUtil.create('div', 'address-result-item address-result-empty', dropdown);
            item.textContent = 'No results found.';
            dropdown.classList.remove('hidden');
            return;
          }
          features.forEach(feature => {
            const item = L.DomUtil.create('div', 'address-result-item', dropdown);
            item.textContent = feature.place_name;
            item.addEventListener('click', () => showResult(feature));
          });
          dropdown.classList.remove('hidden');
        } catch (err) {
          console.error('Address search failed:', err);
          const item = L.DomUtil.create('div', 'address-result-item address-result-empty', dropdown);
          item.textContent = 'Search failed. Check your connection.';
          dropdown.classList.remove('hidden');
        } finally {
          btn.disabled = false;
        }
      }

      btn.addEventListener('click', doSearch);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); doSearch(); }
        if (e.key === 'Escape') closeDropdown();
      });
      document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) closeDropdown();
      });

      return container;
    }
  });

  new AddressSearch().addTo(state.map);
}

// ─── Photo markers ────────────────────────────────────────────────────────────

export function resolveColor(filePath) {
  const pm  = state.meta.photos[filePath];
  const raw = (pm && pm.pinColor) || state.meta.pinColor || state.pinColor || '#4f8ef7';
  return sanitizeColor(raw);
}

export function createPinIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div class="photo-pin-wrapper">
             <div class="photo-pin-circle" style="background:${color}">📷</div>
             <div class="photo-pin-tip" style="border-top-color:${color}"></div>
           </div>`,
    iconSize:   [34, 44],
    iconAnchor: [17, 44],
    popupAnchor:[0, -44]
  });
}

export async function resolvePhotoDisplayUrl(filePath, filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (BROWSER_IMAGE_FORMATS.has(ext)) return window.photoMap.filePathToUrl(filePath);
  const thumbPath = await window.photoMap.getThumbnail(filePath);
  return thumbPath ? window.photoMap.filePathToUrl(thumbPath) : null;
}

export function setMarkerHighlight(filePath, highlight) {
  const entry = state.markers.find(m => m.data.filePath === filePath);
  if (!entry || !entry.onMap || !entry.marker) return;
  entry.marker.setZIndexOffset(highlight ? 1000 : 0);
  const markerEl = entry.marker.getElement();
  if (markerEl) markerEl.querySelector('.photo-pin-wrapper')?.classList.toggle('pin-selected', highlight);
}

export function placeOrMoveMarker(entry, lat, lng) {
  const color = resolveColor(entry.data.filePath);
  if (entry.marker) {
    entry.marker.setLatLng([lat, lng]);
    entry.marker.setIcon(createPinIcon(color));
    if (!entry.onMap) { entry.marker.addTo(state.map); entry.onMap = true; }
  } else {
    const marker = L.marker([lat, lng], { icon: createPinIcon(color), title: entry.data.filename });
    marker.on('click', () => openInfoPanel(entry.data));
    marker.addTo(state.map);
    entry.marker = marker;
    entry.onMap  = true;
  }
}

export function createPhotoMarker(photoData) {
  const pm    = getPhotoMeta(photoData.filePath);
  const isBad = pm.badGps === true;

  if (isBad) {
    state.markers.push({ marker: null, data: photoData, onMap: false });
    return;
  }

  const effLat = pm.gpsOverride ? pm.gpsOverride.lat : photoData.lat;
  const effLng = pm.gpsOverride ? pm.gpsOverride.lng : photoData.lng;
  if (effLat == null || effLng == null) {
    state.markers.push({ marker: null, data: photoData, onMap: false });
    return;
  }

  const marker = L.marker(
    [effLat, effLng],
    { icon: createPinIcon(resolveColor(photoData.filePath)), title: photoData.filename }
  );
  marker.on('click', () => openInfoPanel(photoData));
  marker.addTo(state.map);
  state.markers.push({ marker, data: photoData, onMap: true });
}

export function placePhotoMarkers(photos) {
  for (const p of photos) createPhotoMarker(p);
}

// Note: does NOT call renderPhotoList — callers are responsible for that.
export function refreshMarkerPin(filePath) {
  const entry = state.markers.find(m => m.data.filePath === filePath);
  if (!entry) return;

  const pm    = getPhotoMeta(filePath);
  const isBad = pm.badGps === true;

  if (isBad) {
    if (entry.marker && entry.onMap) { entry.marker.remove(); entry.onMap = false; }
  } else {
    const effLat = pm.gpsOverride ? pm.gpsOverride.lat : entry.data.lat;
    const effLng = pm.gpsOverride ? pm.gpsOverride.lng : entry.data.lng;
    if (effLat != null && effLng != null) {
      placeOrMoveMarker(entry, effLat, effLng);
      if (state.activePhoto?.filePath === filePath) setMarkerHighlight(filePath, true);
    }
  }
}

export function clearPhotoMarkers() {
  for (const { marker, onMap } of state.markers) {
    if (marker && onMap) marker.remove();
  }
  state.markers = [];
}

export function fitMapToMarkers() {
  const points = [];
  state.markers.filter(m => m.onMap && m.marker).forEach(m => points.push(m.marker.getLatLng()));
  state.labelMarkers.forEach(lm => points.push([lm.labelData.lat, lm.labelData.lng]));
  if (!points.length) return;
  state.map.fitBounds(L.latLngBounds(points), { padding: [30, 30] });
}

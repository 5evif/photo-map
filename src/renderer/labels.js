// ─── Map Labels ───────────────────────────────────────────────────────────────
//
// Freeform text labels placed on the map by clicking + Label then clicking a
// spot.  Labels are stored in state.meta.labels and persisted to the sidecar.

import L from 'leaflet';
import { escapeHtml } from '../utils.js';
import { state, el, LABEL_FONT_SIZES } from './state.js';
import { saveMetadata } from './metadata.js';

export function renderAllLabels() {
  for (const labelData of state.meta.labels) {
    createLabelMarker(labelData);
  }
}

export function createLabelMarker(labelData) {
  const fontSize = LABEL_FONT_SIZES[labelData.size] || '16px';
  const icon = L.divIcon({
    className: '',
    html: `<div class="map-label" style="font-size:${fontSize}">${escapeHtml(labelData.text)}</div>`,
    iconSize:   null,
    iconAnchor: [0, 0]
  });

  const marker = L.marker([labelData.lat, labelData.lng], { icon });

  if (state.labelsVisible) marker.addTo(state.map);

  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    openEditLabelPopup(labelData);
  });
  state.labelMarkers.push({ marker, labelData });
}

export function toggleLabelPlacementMode() {
  state.placingLabel = !state.placingLabel;
  el.addLabelBtn.classList.toggle('active', state.placingLabel);
  el.mapDiv.style.cursor   = state.placingLabel ? 'crosshair' : '';
  el.addLabelBtn.textContent = state.placingLabel ? '✕ Cancel' : '+ Label';
  if (state.placingLabel) closeLabelPopup();
}

export function showLabelPopupAtLatLng(latLng) {
  state.placingLabel = false;
  el.addLabelBtn.textContent = '+ Label';
  el.addLabelBtn.classList.remove('active');
  el.mapDiv.style.cursor = '';

  state.pendingLabelLatLng = latLng;
  state.editingLabelId     = null;

  el.labelTextInput.value        = '';
  el.labelSizeSelect.value       = 'medium';
  el.labelPopupTitle.textContent = 'New Label';
  el.saveLabelBtn.textContent    = 'Place Label';
  el.deleteLabelBtn.classList.add('hidden');

  const pt       = state.map.latLngToContainerPoint(latLng);
  const mapRect  = el.mapDiv.getBoundingClientRect();
  const bodyRect = el.appBody.getBoundingClientRect();
  const x = pt.x + (mapRect.left - bodyRect.left);
  const y = pt.y + (mapRect.top  - bodyRect.top);
  el.labelPopup.style.left = Math.min(x, bodyRect.width - 220) + 'px';
  el.labelPopup.style.top  = Math.max(10, y - 160) + 'px';

  el.labelPopup.classList.remove('hidden');
  el.labelTextInput.focus();
}

export function openEditLabelPopup(labelData) {
  state.editingLabelId     = labelData.id;
  state.pendingLabelLatLng = { lat: labelData.lat, lng: labelData.lng };

  el.labelTextInput.value        = labelData.text;
  el.labelSizeSelect.value       = labelData.size;
  el.labelPopupTitle.textContent = 'Edit Label';
  el.saveLabelBtn.textContent    = 'Save Changes';
  el.deleteLabelBtn.classList.remove('hidden');

  el.labelPopup.style.left      = '50%';
  el.labelPopup.style.top       = '30%';
  el.labelPopup.style.transform = 'translate(-50%, 0)';

  el.labelPopup.classList.remove('hidden');
  el.labelTextInput.focus();
}

export async function handleSaveLabel() {
  const text = el.labelTextInput.value.trim();
  if (!text) { el.labelTextInput.focus(); return; }

  const size   = el.labelSizeSelect.value;
  const latLng = state.pendingLabelLatLng;

  if (state.editingLabelId) {
    const idx = state.meta.labels.findIndex(l => l.id === state.editingLabelId);
    if (idx !== -1) {
      state.meta.labels[idx].text = text;
      state.meta.labels[idx].size = size;
      const me = state.labelMarkers.find(m => m.labelData.id === state.editingLabelId);
      if (me) {
        const fs = LABEL_FONT_SIZES[size] || '16px';
        me.marker.setIcon(L.divIcon({
          className: '',
          html: `<div class="map-label" style="font-size:${fs}">${escapeHtml(text)}</div>`,
          iconSize:   null,
          iconAnchor: [0, 0]
        }));
        me.labelData.text = text;
        me.labelData.size = size;
      }
    }
  } else {
    const id  = crypto.randomUUID();
    const lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat;
    const lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng;
    const newLabel = { id, lat, lng, text, size };
    state.meta.labels.push(newLabel);
    createLabelMarker(newLabel);
  }

  await saveMetadata();
  closeLabelPopup();
}

export async function handleDeleteLabel() {
  if (!state.editingLabelId) return;
  const mi = state.labelMarkers.findIndex(m => m.labelData.id === state.editingLabelId);
  if (mi !== -1) { state.labelMarkers[mi].marker.remove(); state.labelMarkers.splice(mi, 1); }
  state.meta.labels = state.meta.labels.filter(l => l.id !== state.editingLabelId);
  await saveMetadata();
  closeLabelPopup();
}

export function closeLabelPopup() {
  el.labelPopup.classList.add('hidden');
  el.labelPopup.style.transform = '';
  state.editingLabelId     = null;
  state.pendingLabelLatLng = null;
}

export function setLabelsVisibility(visible) {
  state.labelsVisible = visible;
  for (const { marker } of state.labelMarkers) {
    if (visible) {
      if (!state.map.hasLayer(marker)) marker.addTo(state.map);
    } else {
      if (state.map.hasLayer(marker)) marker.remove();
    }
  }
}

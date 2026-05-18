// ─── Settings Panel, Export & README Viewer ───────────────────────────────────
//
// Settings overlay (API key, folder, recursive scan, pin color, label toggle),
// GeoJSON/CSV export, and the README viewer overlay.

import { escapeHtml, markdownToHtml, DEFAULT_PIN_COLOR } from '../utils.js';
import { state, el } from './state.js';
import { saveMetadata } from './metadata.js';
import { setLabelsVisibility } from './labels.js';

export function openSettingsPanel() {
  el.settingsApiKey.value       = state.apiKey;
  el.settingsFolder.value       = state.folderPath;
  el.settingsRecursive.checked  = state.recursive;
  el.settingsShowLabels.checked = state.labelsVisible;
  el.settingsPinColor.value     = state.meta.pinColor || state.pinColor;
  el.settingsMessage.classList.add('hidden');
  el.settingsOverlay.classList.remove('hidden');
}

export function closeSettingsPanel() { el.settingsOverlay.classList.add('hidden'); }

export function showSettingsMessage(msg, type = 'success') {
  el.settingsMessage.textContent = msg;
  el.settingsMessage.className   = `settings-message ${type}`;
  el.settingsMessage.classList.remove('hidden');
}

// `onSettingsChanged` is supplied by renderer.js and handles the in-place
// restart — this module stays focused on UI validation and persistence.
export async function handleSaveSettings(onSettingsChanged) {
  const newApiKey     = el.settingsApiKey.value.trim();
  const newFolder     = el.settingsFolder.value.trim();
  const newRecursive  = el.settingsRecursive.checked;
  const newPinColor   = el.settingsPinColor.value;
  const newShowLabels = el.settingsShowLabels.checked;

  if (!newApiKey)  { showSettingsMessage('API key cannot be empty.',      'error'); return; }
  if (!newFolder)  { showSettingsMessage('Please select a photo folder.', 'error'); return; }

  setLabelsVisibility(newShowLabels);

  const apiKeyUnchanged    = newApiKey    === state.apiKey;
  const folderUnchanged    = newFolder    === state.folderPath;
  const recursiveUnchanged = newRecursive === state.recursive;
  const storedColor        = (state.meta.pinColor || state.pinColor || DEFAULT_PIN_COLOR).toLowerCase();
  const colorUnchanged     = newPinColor.toLowerCase() === storedColor;

  if (apiKeyUnchanged && folderUnchanged && recursiveUnchanged && colorUnchanged) {
    closeSettingsPanel();
    return;
  }

  await window.photoMap.saveSettings({
    apiKey: newApiKey, folderPath: newFolder, recursive: newRecursive, pinColor: newPinColor
  });

  state.meta.pinColor = newPinColor;
  await saveMetadata();

  await window.photoMap.releaseLock(state.folderPath);

  onSettingsChanged({ newApiKey, newFolder, newRecursive, newPinColor,
    apiKeyChanged: !apiKeyUnchanged, folderChanged: !folderUnchanged,
    recursiveChanged: !recursiveUnchanged, colorChanged: !colorUnchanged });
}

// Called once by renderer.js during bindAppEvents().
// `onSettingsChanged` is the applyNewSettings function from scanner.js.
export function registerSettingsEvents(onSettingsChanged) {
  el.closeSettingsBtn.addEventListener('click', closeSettingsPanel);
  el.cancelSettingsBtn.addEventListener('click', closeSettingsPanel);
  el.saveSettingsBtn.addEventListener('click', () => handleSaveSettings(onSettingsChanged));
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

  el.closeReadmeBtn.addEventListener('click', closeReadme);
  el.readmeOverlay.addEventListener('click', (e) => {
    if (e.target === el.readmeOverlay) closeReadme();
  });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function handleExport(format) {
  const exportPhotos = state.photos
    .map(p => {
      const pm = state.meta.photos[p.filePath] || {};
      if (pm.badGps) return null;
      const lat = pm.gpsOverride ? pm.gpsOverride.lat : p.lat;
      const lng = pm.gpsOverride ? pm.gpsOverride.lng : p.lng;
      if (lat == null || lng == null) return null;
      return { ...p, lat, lng };
    })
    .filter(Boolean);

  if (!exportPhotos.length) {
    showSettingsMessage('No photos with GPS to export.', 'error');
    return;
  }

  let result;
  try {
    result = await window.photoMap.exportData({ photos: exportPhotos, metadata: state.meta, format });
  } catch (err) {
    showSettingsMessage(`Export failed: ${err.message}`, 'error');
    return;
  }

  if (!result) {
    showSettingsMessage('Export failed: no response from the app backend.', 'error');
    return;
  }

  if (result.success) {
    showSettingsMessage(
      `✓ Exported ${result.count} photos as ${format === 'geojson' ? 'GeoJSON' : 'CSV'}.`
    );
  } else if (result.error !== 'Cancelled') {
    showSettingsMessage(`Export failed: ${result.error}`, 'error');
  }
}

// ─── README viewer ────────────────────────────────────────────────────────────

export async function openReadme() {
  el.readmeBody.innerHTML = '<p class="readme-loading">Loading…</p>';
  el.readmeOverlay.classList.remove('hidden');

  const result = await window.photoMap.readReadme();

  if (!result.success) {
    el.readmeBody.innerHTML = `<p class="readme-error">Could not load README: ${escapeHtml(result.error)}</p>`;
    return;
  }

  el.readmeBody.innerHTML  = markdownToHtml(result.text);
  el.readmeBody.scrollTop  = 0;
}

export function closeReadme() {
  el.readmeOverlay.classList.add('hidden');
}

/*
 * renderer.js — Entry Point & Orchestrator
 *
 * Responsibilities:
 *   - Application init (load settings, wire IPC listeners, decide which screen)
 *   - Screen switching (setup ↔ app)
 *   - Setup screen event handling
 *   - Top-level event wiring: toolbar, global keyboard, lock overlay
 *   - Delegates feature-module event wiring to registerXxxEvents() calls
 *
 * Business logic lives in dedicated modules:
 *   scanner.js     — scan pipeline, folder watch, settings reload, lock screen
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
import { state, el, qrEl, setStatus }           from './state.js';
import { loadMetadata }                          from './metadata.js';
import { launchMap }                             from './map.js';
import { registerPhotoListEvents }               from './photoList.js';
import { closeInfoPanel, applySidebarWidth, navigatePhoto, registerInfoPanelEvents, closeLightbox } from './infoPanel.js';
import { renderAllLabels, toggleLabelPlacementMode, showLabelPopupAtLatLng, registerLabelEvents } from './labels.js';
import { openQuickRename, closeQuickRename }     from './quickRename.js';
import { openSettingsPanel, openReadme, closeReadme, registerSettingsEvents } from './settings.js';
import {
  scanAndDisplay, watchFolder, handleFolderChange,
  applyNewSettings, showLockError, hideLockError, setFolderName
} from './scanner.js';

// ─── Initialization ────────────────────────────────────────────────────────────

async function init() {
  const settings = await window.photoMap.getSettings();
  state.apiKey       = settings.apiKey      || '';
  state.folderPath   = settings.folderPath  || '';
  state.recursive    = settings.recursive   !== false;
  state.sidebarWidth = settings.sidebarWidth || 340;
  state.pinColor     = settings.pinColor    || '#4f8ef7';

  applySidebarWidth(state.sidebarWidth);

  if (window.photoMap.platform === 'darwin') document.body.classList.add('macos');

  window.photoMap.onFolderChanged(handleFolderChange);
  window.photoMap.onOpenSettings(openSettingsPanel);
  window.photoMap.onScanProgress(({ processed, total, withGps }) =>
    setStatus(`Scanning… ${processed} / ${total} files · ${withGps} with GPS`)
  );
  window.addEventListener('offline', () => setStatus('⚠ No network connection — map tiles may not load.'));
  window.addEventListener('online',  () => setStatus('Network restored.'));

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

// ─── Map launch ────────────────────────────────────────────────────────────────

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

  // Feature-module event wiring
  registerPhotoListEvents();
  registerInfoPanelEvents();
  registerLabelEvents();
  registerSettingsEvents(applyNewSettings);

  // Global keyboard shortcuts (cross-module: must stay here)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!el.lightbox.classList.contains('hidden'))      { closeLightbox();    return; }
      if (!el.readmeOverlay.classList.contains('hidden')) { closeReadme();      return; }
      if (!qrEl.overlay.classList.contains('hidden'))     { closeQuickRename(); return; }
      closeInfoPanel();
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA')         return;
      if (el.infoPanel.classList.contains('hidden'))     return;
      if (!el.lightbox.classList.contains('hidden'))     return;
      if (!qrEl.overlay.classList.contains('hidden'))    return;
      e.preventDefault();
      navigatePhoto(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  // Lock error overlay
  el.lockRetryBtn.addEventListener('click', async () => {
    const result = await window.photoMap.acquireLock(state.folderPath);
    if (result.success) {
      hideLockError(); showScreen('app'); setFolderName(state.folderPath); startMap();
    } else {
      showLockError(result, state.folderPath);
    }
  });
  el.lockSettingsBtn.addEventListener('click', () => { hideLockError(); showScreen('setup'); });
}

// ─── Start ─────────────────────────────────────────────────────────────────────

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection in renderer:', event.reason);
  setStatus(`⚠ Unexpected error: ${event.reason?.message || event.reason}`);
});

document.addEventListener('DOMContentLoaded', init);

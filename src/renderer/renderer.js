/*
 * renderer.js — The Visible Window Logic
 *
 * This file runs inside the browser window and drives everything the user
 * sees and interacts with.  It talks to the main process exclusively through
 * window.photoMap, which is provided by preload.js.
 *
 * Responsibilities:
 *   - Setup screen: API key + folder picker shown on every launch,
 *     pre-populated with last-used values (skipped when reloading after settings save)
 *   - Main map view: Leaflet/MapTiler satellite view, photo pin markers,
 *     freeform text labels, live folder watching
 *   - Photo list sidebar (left): searchable, filterable list of all GPS photos
 *     with ⚠ bad-GPS, 📝 note, and ✎ GPS-override badges; filter by All / Bad GPS / Has Note / GPS Set
 *   - Info panel (right): thumbnail with zoom lightbox, rename with one-level
 *     undo (Cmd/Ctrl+Z), notes with one-level undo, bad-GPS flag, per-photo pin color
 *   - Resizable info panel: drag handle saves width across sessions
 *   - Quick Rename mode: full-screen cycle through photos for fast renaming,
 *     with mini satellite map, notes, and bad-GPS toggle
 *   - Settings panel: API key, folder, scan options, pin color, label toggle,
 *     GeoJSON / CSV export, thumbnail cache management, README viewer
 *   - Lock error screen: blocks the UI if another user has the folder open,
 *     or if the folder is read-only and annotations cannot be saved
 *   - Offline detection: status bar warning when the network drops
 *
 * Data flow:
 *   On startup → show setup screen (pre-populated) → user clicks Open Map →
 *   acquire folder lock → save settings → init Leaflet map → load metadata →
 *   scan photos (with live progress) → place markers → watch folder
 *
 * Metadata (notes, bad-GPS flags, pin colors, labels) lives in state.meta,
 * which mirrors photo-map-data.json on disk.  Every change is written back
 * to disk immediately via saveMetadata(), which surfaces write errors in
 * the status bar rather than silently losing data.
 */

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
  apiKey:       '',
  folderPath:   '',
  recursive:    true,
  pinColor:     '#4f8ef7',   // global default pin color

  // All per-photo and label metadata, loaded from photo-map-data.json
  meta: {
    version:  1,
    pinColor: '#4f8ef7',
    labels:   [],            // [{ id, lat, lng, text, size }]
    photos:   {}             // { [filePath]: { note, badGps, pinColor } }
  },

  photos:   [],              // array of { lat, lng, date, filename, filePath }

  map:          null,
  satelliteLayer: null,
  streetsLayer:   null,
  markers:      [],          // [{ marker, data, onMap }]  — onMap: bool, marker: L.Marker or null
  labelMarkers: [],
  labelsVisible: true,

  activePhoto:     null,
  placingLabel:    false,
  pickingCoords:   false,
  lastGpsEdit:     null,
  editingLabelId:  null,
  pendingLabelLatLng: null,

  // Lightbox
  lightboxScale:   1,
  lightboxOrigin:  { x: 0, y: 0 },

  // Sidebar resize
  sidebarWidth:    340,
  isResizing:      false,

  // Undo — stores one level of rename undo so the last rename can be reversed.
  // Shape: { oldPath, oldName, newPath, newName, metaSnapshot } or null.
  lastRename:      null,

  // Photo list filter — 'all', 'bad', 'note', or 'override'
  listFilter:      'all',

  // Note undo — stores the previous note text so Save Note can be reversed.
  // Shape: { filePath, previousNote } or null.
  lastNote:        null
};

// ─── DOM references ────────────────────────────────────────────────────────────

const el = {
  // Screens
  setupScreen:    document.getElementById('setup-screen'),
  appView:        document.getElementById('app-view'),

  // Setup
  apiKeyInput:    document.getElementById('api-key-input'),
  folderPathInput:document.getElementById('folder-path-input'),
  browseBtn:      document.getElementById('browse-btn'),
  setupContinueBtn:document.getElementById('setup-continue-btn'),
  setupReadmeBtn:  document.getElementById('setup-readme-btn'),
  setupError:     document.getElementById('setup-error'),

  // Toolbar
  toggleListBtn:  document.getElementById('toggle-list-btn'),
  addLabelBtn:    document.getElementById('add-label-btn'),
  rescanBtn:      document.getElementById('rescan-btn'),
  settingsBtn:    document.getElementById('settings-btn'),
  quickRenameBtn: document.getElementById('quick-rename-btn'),

  // Layout
  photoListPanel: document.getElementById('photo-list-panel'),
  listSearch:     document.getElementById('list-search'),
  photoListItems: document.getElementById('photo-list-items'),
  resizeHandle:   document.getElementById('sidebar-resize-handle'),

  // Info panel
  infoPanel:      document.getElementById('info-panel'),
  closePanelBtn:  document.getElementById('close-panel-btn'),
  prevPhotoBtn:   document.getElementById('prev-photo-btn'),
  nextPhotoBtn:   document.getElementById('next-photo-btn'),
  photoThumbnail: document.getElementById('photo-thumbnail'),
  thumbnailLoading:document.getElementById('thumbnail-loading'),
  zoomBtn:        document.getElementById('zoom-btn'),
  renameInput:    document.getElementById('rename-input'),
  renameExt:      document.getElementById('rename-ext'),
  renameBtn:      document.getElementById('rename-btn'),
  renameError:    document.getElementById('rename-error'),
  renameSuccess:  document.getElementById('rename-success'),
  photoDate:      document.getElementById('photo-date'),
  photoCoords:    document.getElementById('photo-coords'),
  setCoordsBtn:   document.getElementById('set-coords-btn'),
  coordsEditArea: document.getElementById('coords-edit-area'),
  gpsLatInput:    document.getElementById('gps-lat-input'),
  gpsLngInput:    document.getElementById('gps-lng-input'),
  saveCoordsBtn:  document.getElementById('save-coords-btn'),
  cancelCoordsBtn:document.getElementById('cancel-coords-btn'),
  coordsError:    document.getElementById('coords-error'),
  undoCoordsBtn:  document.getElementById('undo-coords-btn'),
  clearCoordsBtn: document.getElementById('clear-coords-btn'),
  photoNotes:     document.getElementById('photo-notes'),
  saveNoteBtn:    document.getElementById('save-note-btn'),
  noteSavedMsg:   document.getElementById('note-saved-msg'),
  badGpsCheckbox: document.getElementById('bad-gps-checkbox'),
  photoPinColor:  document.getElementById('photo-pin-color'),
  resetPinColorBtn:document.getElementById('reset-pin-color-btn'),
  showInFinderBtn:document.getElementById('show-in-finder-btn'),
  undoRenameBtn:   document.getElementById('undo-rename-btn'),
  undoNoteBtn:     document.getElementById('undo-note-btn'),

  // Lightbox
  lightbox:       document.getElementById('lightbox'),
  lightboxClose:  document.getElementById('lightbox-close'),
  lightboxInner:  document.getElementById('lightbox-inner'),
  lightboxImg:    document.getElementById('lightbox-img'),
  lightboxCaption:document.getElementById('lightbox-caption'),

  // Settings
  settingsOverlay:    document.getElementById('settings-overlay'),
  settingsApiKey:     document.getElementById('settings-api-key'),
  settingsFolder:     document.getElementById('settings-folder'),
  settingsBrowseBtn:  document.getElementById('settings-browse-btn'),
  settingsRecursive:  document.getElementById('settings-recursive'),
  settingsShowLabels: document.getElementById('settings-show-labels'),
  settingsPinColor:   document.getElementById('settings-pin-color'),
  exportGeoJsonBtn:   document.getElementById('export-geojson-btn'),
  exportCsvBtn:       document.getElementById('export-csv-btn'),
  clearCacheBtn:      document.getElementById('clear-cache-btn'),
  settingsMessage:    document.getElementById('settings-message'),
  saveSettingsBtn:    document.getElementById('save-settings-btn'),
  cancelSettingsBtn:  document.getElementById('cancel-settings-btn'),
  closeSettingsBtn:   document.getElementById('close-settings-btn'),
  viewReadmeBtn:      document.getElementById('view-readme-btn'),

  // README viewer
  readmeOverlay:      document.getElementById('readme-overlay'),
  readmeBody:         document.getElementById('readme-body'),
  closeReadmeBtn:     document.getElementById('close-readme-btn'),

  // Label popup
  labelPopup:         document.getElementById('label-popup'),
  labelPopupTitle:    document.getElementById('label-popup-title'),
  labelTextInput:     document.getElementById('label-text-input'),
  labelSizeSelect:    document.getElementById('label-size-select'),
  saveLabelBtn:       document.getElementById('save-label-btn'),
  deleteLabelBtn:     document.getElementById('delete-label-btn'),
  closeLabelPopupBtn: document.getElementById('close-label-popup-btn'),

  // Auth error
  authErrorBanner:        document.getElementById('auth-error-banner'),
  authErrorTitle:         document.getElementById('auth-error-title'),
  authErrorKeyDetail:     document.getElementById('auth-error-key-detail'),
  authErrorQuotaDetail:   document.getElementById('auth-error-quota-detail'),
  authErrorSettingsLink:  document.getElementById('auth-error-settings-link'),

  // Lock error overlay
  lockOverlay:     document.getElementById('lock-overlay'),
  lockTitle:       document.getElementById('lock-title'),
  lockMessage:     document.getElementById('lock-message'),
  lockDetail:      document.getElementById('lock-detail'),
  lockRetryBtn:    document.getElementById('lock-retry-btn'),
  lockSettingsBtn: document.getElementById('lock-settings-btn'),

  // Status
  statusText: document.getElementById('status-text'),

  // Map and body — used by label placement and popup positioning
  mapDiv:     document.getElementById('map'),
  appBody:    document.getElementById('app-body')
};

// ─── Initialization ─────────────────────────────────────────────────────────────

async function init() {
  const settings = await window.photoMap.getSettings();
  state.apiKey       = settings.apiKey      || '';
  state.folderPath   = settings.folderPath  || '';
  state.recursive    = settings.recursive   !== false;
  state.sidebarWidth = settings.sidebarWidth || 340;
  state.pinColor     = settings.pinColor    || '#4f8ef7';

  // Apply the saved sidebar width immediately — this also positions the resize
  // handle correctly, which would otherwise sit at the CSS default (340px) even
  // if the user had previously resized to a different width.
  applySidebarWidth(state.sidebarWidth);

  // On macOS the window traffic-light buttons (close/minimise/maximise) are
  // overlaid on the toolbar, so we need extra left padding to clear them.
  if (window.photoMap.platform === 'darwin') {
    document.body.classList.add('macos');
  }

  window.photoMap.onFolderChanged(handleFolderChange);
  window.photoMap.onOpenSettings(openSettingsPanel);

  // Show live scan progress in the status bar while the folder is being scanned.
  window.photoMap.onScanProgress(({ processed, total, withGps }) => {
    setStatus(`Scanning… ${processed} / ${total} files · ${withGps} with GPS`);
  });

  // Detect when the network drops so map tiles and the API stop loading.
  window.addEventListener('offline', () =>
    setStatus('⚠ No network connection — map tiles may not load.')
  );
  window.addEventListener('online', () =>
    setStatus('Network restored.')
  );

  bindSetupEvents();
  bindAppEvents();

  // If this session was launched by "Save & Reload" in Settings, skip the
  // welcome screen — the user is already authenticated and just wants the app.
  // sessionStorage is cleared automatically when the window closes.
  const skipSetup = sessionStorage.getItem('skipSetup') === '1';
  if (skipSetup) {
    sessionStorage.removeItem('skipSetup');
    if (state.apiKey && state.folderPath) {
      const lockResult = await window.photoMap.acquireLock(state.folderPath);
      if (!lockResult.success) { showLockError(lockResult, state.folderPath); return; }
      showScreen('app');
      setFolderName(state.folderPath);
      launchMap();
      return;
    }
  }

  // Normal launch — always show the setup screen pre-populated with last-used values.
  el.apiKeyInput.value     = state.apiKey;
  el.folderPathInput.value = state.folderPath;
  showScreen('setup');
}

// ─── Screen management ─────────────────────────────────────────────────────────

/*
 * Shows one of the main screens (setup or app) and hides everything else,
 * including the lock error overlay which must be cleared when navigating away.
 */
function showScreen(name) {
  el.setupScreen.classList.toggle('hidden', name !== 'setup');
  el.appView.classList.toggle('hidden',     name !== 'app');
  // Always hide the lock overlay when switching screens — it sits at z-index 800
  // so it would obscure the target screen if left visible.
  el.lockOverlay.classList.add('hidden');
}

// ─── Setup screen ──────────────────────────────────────────────────────────────

/*
 * Binds all event listeners for the setup screen (API key + folder picker).
 * Called once during init() before the screen is shown.
 */
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
  if (!folderPath) { showSetupError('Please select your photo folder.');       return; }

  hideSetupError();

  // Try to acquire the lock before proceeding. If the folder is in use or
  // read-only the lock error screen will explain why and offer options.
  const lockResult = await window.photoMap.acquireLock(folderPath);
  if (!lockResult.success) {
    showLockError(lockResult, folderPath);
    return;
  }

  await window.photoMap.saveSettings({ apiKey, folderPath, recursive: state.recursive });
  state.apiKey = apiKey; state.folderPath = folderPath;
  showScreen('app');
  setFolderName(folderPath);
  launchMap();
}

function showSetupError(msg) { el.setupError.textContent = msg; el.setupError.classList.remove('hidden'); }
function hideSetupError()    { el.setupError.classList.add('hidden'); }

// ─── Leaflet / MapTiler ────────────────────────────────────────────────────────

// Formats the browser (Chromium) can decode and display directly.
// HEIC, DNG, HEIF are not natively supported — fall back to the generated thumbnail.
const BROWSER_IMAGE_FORMATS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

const LABEL_FONT_SIZES = { small: '12px', medium: '16px', large: '22px' };

const MAPTILER_ATTRIBUTION =
  '© <a href="https://www.maptiler.com/copyright/" target="_blank">MapTiler</a> ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a> ' +
  '| <a href="https://leafletjs.com" target="_blank">Leaflet</a>';

function showAuthError(status = 0) {
  const quotaExceeded = status === 429;
  el.authErrorTitle.textContent = quotaExceeded
    ? '⚠ MapTiler request limit reached — free tier quota exceeded.'
    : '⚠ MapTiler API key error — map tiles failed to load.';
  el.authErrorKeyDetail.classList.toggle('hidden', quotaExceeded);
  el.authErrorQuotaDetail.classList.toggle('hidden', !quotaExceeded);
  el.authErrorBanner.classList.remove('hidden');
}

async function initMap() {
  // Prevent double-init if called again (e.g. from retry path).
  if (state.map) return;

  state.map = L.map('map', {
    center:    [20, 0],
    zoom:      2,
    zoomControl: false
  });

  state.satelliteLayer = L.tileLayer(
    `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=${state.apiKey}`,
    {
      tileSize:    512,
      zoomOffset:  -1,
      maxZoom:     20,
      attribution: MAPTILER_ATTRIBUTION,
      crossOrigin: true
    }
  );

  state.streetsLayer = L.tileLayer(
    `https://api.maptiler.com/maps/openstreetmap/{z}/{x}/{y}.png?key=${state.apiKey}`,
    {
      maxZoom:     19,
      attribution: MAPTILER_ATTRIBUTION,
      crossOrigin: true
    }
  );

  state.satelliteLayer.addTo(state.map);

  L.control.layers(
    { 'Satellite': state.satelliteLayer, 'OpenStreetMap': state.streetsLayer },
    null,
    { position: 'topright' }
  ).addTo(state.map);

  L.control.zoom({ position: 'topright' }).addTo(state.map);

  // Detect tile failures and show the appropriate banner.
  // We probe the failed tile URL from the main process (no CORS) to get
  // the real HTTP status — 429 means quota exceeded, 401/403 means bad key.
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
    if (state.placingLabel) { showLabelPopupAtLatLng(e.latlng); return; }
    if (state.pickingCoords) {
      el.gpsLatInput.value = e.latlng.lat.toFixed(6);
      el.gpsLngInput.value = e.latlng.lng.toFixed(6);
    }
  });

  addAddressSearch();

  // Load metadata from the photo folder before rendering anything.
  await loadMetadata();
  renderAllLabels();
  await scanAndDisplay();
  watchFolder();
}

function addAddressSearch() {
  const AddressSearch = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const container = L.DomUtil.create('div', 'address-search');
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      const row = L.DomUtil.create('div', 'address-search-row', container);
      const input = L.DomUtil.create('input', 'address-search-input', row);
      input.type = 'text';
      input.placeholder = 'Search address…';
      input.setAttribute('aria-label', 'Search for an address');

      const btn = L.DomUtil.create('button', 'btn address-search-btn', row);
      btn.title = 'Search';
      btn.textContent = '⌕';

      const dropdown = L.DomUtil.create('div', 'address-results hidden', container);

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
          iconSize:   [14, 14],
          iconAnchor: [7, 7]
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
          const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${state.apiKey}&limit=5`;
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

function launchMap() {
  initMap().catch(err => {
    console.error('Map init failed:', err);
    setStatus('⚠ Map failed to load: ' + err.message);
  });
}

// ─── Metadata file (photo-map-data.json) ───────────────────────────────────────

/*
 * Reads the metadata file from the photo folder and stores it in state.meta.
 * All per-photo annotations and map labels live here.
 */
async function loadMetadata() {
  state.meta = await window.photoMap.readMetadata(state.folderPath);
  // Ensure required shape is present even for old/partial files.
  state.meta.photos = state.meta.photos || {};
  state.meta.labels = state.meta.labels || [];
  state.meta.pinColor = state.meta.pinColor || state.pinColor;
}

/*
 * Writes the current state.meta object back to photo-map-data.json.
 * Called whenever anything in state.meta changes (notes, flags, labels, etc.)
 *
 * If the write fails (e.g. the network drive went offline, or the disk is full)
 * a warning appears in the status bar so the user knows their change was not saved.
 * We do not throw — the app keeps running with the in-memory state intact, and
 * the user can try again by making another change.
 */
async function saveMetadata() {
  const result = await window.photoMap.writeMetadata({
    folderPath: state.folderPath,
    metadata:   state.meta
  });
  if (result && !result.success) {
    setStatus(`⚠ Could not save annotations: ${result.error}`);
  }
}

/*
 * Returns the metadata record for a given file path.
 * If no record exists yet, returns a fresh empty one (without saving).
 */
function getPhotoMeta(filePath) {
  if (!state.meta.photos[filePath]) {
    state.meta.photos[filePath] = { note: '', badGps: false, pinColor: null, gpsOverride: null };
  }
  return state.meta.photos[filePath];
}

// ─── Scanning & Markers ─────────────────────────────────────────────────────────

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
  // Rebuild clears all marker highlights. Restore the active pin if the photo
  // still exists; close the panel if it was removed from disk since last scan.
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

/*
 * Appends no-GPS photos to state.photos.
 * On first encounter (no existing metadata entry) auto-sets badGps and a note.
 */
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

function placePhotoMarkers(photos) {
  for (const p of photos) {
    createPhotoMarker(p);
  }
}

/*
 * Moves an existing map marker to new coordinates, or creates one from scratch
 * if the entry never had a marker (e.g. was initially flagged as bad GPS).
 * Shared by handleSaveCoords, handleUndoCoords, handleClearCoordsOverride,
 * and refreshMarkerPin so the create-or-update logic lives in one place.
 */
function placeOrMoveMarker(entry, lat, lng) {
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

/*
 * Returns the URL to display for a photo.
 * Browser-decodable formats (JPEG, PNG, WebP, AVIF) are served directly from
 * disk; everything else (HEIC, DNG, etc.) goes through the thumbnail generator.
 */
async function resolvePhotoDisplayUrl(filePath, filename) {
  const ext = getExtension(filename).toLowerCase();
  if (BROWSER_IMAGE_FORMATS.has(ext)) return window.photoMap.filePathToUrl(filePath);
  const thumbPath = await window.photoMap.getThumbnail(filePath);
  return thumbPath ? window.photoMap.filePathToUrl(thumbPath) : null;
}

/*
 * Resolves the correct pin color for a given photo.
 * Per-photo color → global meta color → app settings color → hardcoded default.
 */
function resolveColor(filePath) {
  const pm  = state.meta.photos[filePath];
  const raw = (pm && pm.pinColor) || state.meta.pinColor || state.pinColor || '#4f8ef7';
  return sanitizeColor(raw);
}

/*
 * Returns a Leaflet DivIcon for a photo pin with the given color.
 * The icon consists of a colored circle with a 📷 glyph and a downward tip.
 * iconAnchor is at the bottom of the tip so the pin points to the exact location.
 */
function createPinIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div class="photo-pin-wrapper">
             <div class="photo-pin-circle" style="background:${color}">📷</div>
             <div class="photo-pin-tip" style="border-top-color:${color}"></div>
           </div>`,
    iconSize:   [34, 44],
    iconAnchor: [17, 44],  // bottom-center of the tip
    popupAnchor:[0, -44]
  });
}

/*
 * Creates a single map marker for a photo.
 * Photos flagged as bad GPS, or with no coordinates and no override, are stored
 * as null-marker entries so the info panel and photo list can still reach their
 * data; they just have no visible pin.
 */
function createPhotoMarker(photoData) {
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

/*
 * Responds to a change in pin color or bad-GPS flag for a single photo.
 * If now flagged bad GPS, removes pin from map.
 * If un-flagged or color changed, adds/updates the pin.
 */
function refreshMarkerPin(filePath) {
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

  renderPhotoList();
}

function clearPhotoMarkers() {
  for (const { marker, onMap } of state.markers) {
    if (marker && onMap) marker.remove();
  }
  state.markers = [];
}

/*
 * Adjusts the map zoom and centre so all visible photo markers fit on screen.
 * Bad-GPS entries (onMap: false) are excluded.
 */
function fitMapToMarkers() {
  const points = [];
  state.markers.filter(m => m.onMap && m.marker).forEach(m => points.push(m.marker.getLatLng()));
  state.labelMarkers.forEach(lm => points.push([lm.labelData.lat, lm.labelData.lng]));
  if (!points.length) return;
  state.map.fitBounds(L.latLngBounds(points), { padding: [30, 30] });
}

// ─── Photo List (left sidebar) ─────────────────────────────────────────────────

/*
 * Adds or removes the "pin-selected" CSS class from a photo's map marker.
 * The class scales the pin up and brightens its border so the selected photo
 * is visually distinct from unselected ones.
 * Called from openInfoPanel (highlight) and closeInfoPanel (unhighlight).
 *
 * Input: filePath  — the photo whose pin to update
 *        highlight — true to highlight, false to restore normal state
 */
function setMarkerHighlight(filePath, highlight) {
  const entry = state.markers.find(m => m.data.filePath === filePath);
  if (!entry || !entry.onMap || !entry.marker) return;
  // setZIndexOffset brings the pin above its neighbours so the scaled-up
  // selected pin is never hidden behind an adjacent one.
  entry.marker.setZIndexOffset(highlight ? 1000 : 0);
  const markerEl = entry.marker.getElement();
  if (markerEl) markerEl.querySelector('.photo-pin-wrapper')?.classList.toggle('pin-selected', highlight);
}

/*
 * Returns the sorted, filtered photo array matching the current search query
 * and active filter button.  Used by renderPhotoList and navigatePhoto so the
 * filter logic lives in one place.
 */
function getFilteredPhotos() {
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

/*
 * Renders the scrollable list of photos in the left sidebar.
 * Applies the current text search and category filter (All / Bad GPS / Has Note / GPS Set)
 * so only matching photos are shown. Clicking a row pans to that photo and
 * opens the info panel.
 */
function renderPhotoList() {
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
    row.className = 'list-row' + (state.activePhoto?.filePath === photo.filePath ? ' active' : '');
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
      const pm = getPhotoMeta(photo.filePath);
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

/*
 * Shows only the markers whose filePaths are in visiblePaths.
 * Does not modify entry.onMap — that flag reflects GPS/badGps state,
 * not filter state — so clearing the filter restores markers correctly.
 */
function applyMarkerFilter(visiblePaths) {
  if (!state.map) return;
  for (const entry of state.markers) {
    if (!entry.marker) continue;
    const shouldShow = entry.onMap && visiblePaths.has(entry.data.filePath);
    const isOnMap    = state.map.hasLayer(entry.marker);
    if (shouldShow && !isOnMap)  entry.marker.addTo(state.map);
    if (!shouldShow && isOnMap)  entry.marker.remove();
  }
}

// ─── Folder Watching ───────────────────────────────────────────────────────────

async function watchFolder() {
  await window.photoMap.watchFolder({ folderPath: state.folderPath, recursive: state.recursive });
}

async function handleFolderChange({ type, filePath }) {
  if (type === 'add') {
    const result = await window.photoMap.scanFolder({ folderPath: state.folderPath, recursive: state.recursive });
    if (result.error) {
      setStatus(`⚠ ${result.error}`);
    } else {
      clearPhotoMarkers();
      state.photos = result.photos;
      await mergeNoGpsPhotos(result.noGpsPhotos);
      placePhotoMarkers(state.photos);
      // Rebuild markers clears the highlight — restore it if a photo is still open.
      if (state.activePhoto) setMarkerHighlight(state.activePhoto.filePath, true);
      renderPhotoList();
      setStatus(`${result.totalScanned} photos · ${result.totalWithGps} with GPS`);
    }
  } else if (type === 'remove') {
    const idx = state.markers.findIndex(m => m.data.filePath === filePath);
    if (idx !== -1) {
      const { marker, onMap } = state.markers[idx];
      if (marker && onMap) marker.remove();
      state.markers.splice(idx, 1);
      state.photos = state.photos.filter(p => p.filePath !== filePath);
      renderPhotoList();
      if (state.activePhoto?.filePath === filePath) closeInfoPanel();
      setStatus(`${state.photos.filter(p => p.lat != null).length} photos with GPS`);
    }
  }
}

// ─── Info Panel ────────────────────────────────────────────────────────────────

/*
 * Opens the right info panel for the given photo.
 * Before loading the new photo, any unsaved note for the previously active
 * photo is saved automatically so the user never loses edits just by
 * clicking a different marker.
 */
async function openInfoPanel(photoData) {
  // Flush any unsaved note from the photo we're leaving — but do it in the
  // background (no await) so the panel opens immediately on the first click.
  // The save is fire-and-forget here; metadata writes are fast and non-blocking.
  if (state.activePhoto && state.activePhoto.filePath !== photoData.filePath) {
    const prevPm = getPhotoMeta(state.activePhoto.filePath);
    const currentNote = el.photoNotes.value;
    if (currentNote !== (prevPm.note || '')) {
      prevPm.note = currentNote;
      saveMetadata().then(() => renderPhotoList()); // intentionally not awaited
    }
    // Unhighlight the pin we're leaving before highlighting the new one.
    setMarkerHighlight(state.activePhoto.filePath, false);
  }

  state.activePhoto = photoData;
  // Highlight the pin for the newly selected photo.
  setMarkerHighlight(photoData.filePath, true);
  const pm = getPhotoMeta(photoData.filePath);

  const ext         = getExtension(photoData.filename);
  const nameWithout = photoData.filename.slice(0, -ext.length);

  el.renameInput.value    = nameWithout;
  el.renameExt.textContent = ext;
  el.photoDate.textContent = photoData.date ? formatDate(photoData.date) : 'Not available';
  const effLat = pm.gpsOverride ? pm.gpsOverride.lat : photoData.lat;
  const effLng = pm.gpsOverride ? pm.gpsOverride.lng : photoData.lng;
  el.photoCoords.textContent = (effLat != null && effLng != null)
    ? `${effLat.toFixed(6)}, ${effLng.toFixed(6)}` : 'None';

  // Load saved note and flags.
  el.photoNotes.value        = pm.note    || '';
  el.badGpsCheckbox.checked  = pm.badGps  === true;
  el.photoPinColor.value     = pm.pinColor || resolveColor(photoData.filePath);

  hideRenameMessages();
  el.noteSavedMsg.classList.add('hidden');

  // Clear all undo states when switching to a new photo.
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
  state.map?.invalidateSize();
  el.zoomBtn.classList.add('hidden');

  el.photoThumbnail.style.display = 'none';
  el.thumbnailLoading.style.display = 'flex';

  // Capture the path before the await so we can detect if the user opened a
  // different photo while the thumbnail was still loading (e.g. a slow HEIC
  // decode). If the active photo changed, discard this result silently —
  // the newer openInfoPanel call is responsible for updating the UI.
  const expectedPath = photoData.filePath;
  const displayUrl = await resolvePhotoDisplayUrl(photoData.filePath, photoData.filename);
  if (state.activePhoto?.filePath !== expectedPath) return;

  if (displayUrl) {
    el.photoThumbnail.src = displayUrl;
    el.photoThumbnail.dataset.url = displayUrl;
    el.photoThumbnail.style.display = 'block';
    el.zoomBtn.classList.remove('hidden');
  }
  el.thumbnailLoading.style.display = 'none';
  updateNavButtons();
}

function closeInfoPanel() {
  if (state.activePhoto) setMarkerHighlight(state.activePhoto.filePath, false);
  exitCoordsEditMode();
  el.infoPanel.classList.add('hidden');
  el.resizeHandle.classList.add('hidden');
  state.activePhoto = null;
  state.map?.invalidateSize();
  updateNavButtons();
}

/*
 * Enables or disables the ← / → nav buttons based on where the active photo
 * sits in the current filtered list.  Called whenever the panel opens, closes,
 * or the filter/search changes.
 */
function updateNavButtons() {
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

/*
 * Moves to the previous (dir = -1) or next (dir = 1) photo in the current
 * filtered list, pans the map to it, and scrolls its list row into view.
 */
function navigatePhoto(dir) {
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

  // Sync the active highlight in the list without a full re-render.
  document.querySelectorAll('.list-row.active').forEach(r => r.classList.remove('active'));
  const row = document.querySelector(`.list-row[data-filepath="${CSS.escape(next.filePath)}"]`);
  if (row) { row.classList.add('active'); row.scrollIntoView({ block: 'nearest' }); }
}

// ─── GPS Edit ─────────────────────────────────────────────────────────────────

function enterCoordsEditMode() {
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

function exitCoordsEditMode() {
  state.pickingCoords = false;
  el.coordsEditArea?.classList.add('hidden');
  el.setCoordsBtn?.classList.remove('hidden');
  state.map?.getContainer().classList.remove('cursor-crosshair');
}

async function handleSaveCoords() {
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


async function handleUndoCoords() {
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

async function handleClearCoordsOverride() {
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

/*
 * Saves the note from the textarea to state.meta and then to disk.
 */
async function handleSaveNote() {
  if (!state.activePhoto) return;
  const pm = getPhotoMeta(state.activePhoto.filePath);

  // Snapshot the previous note before overwriting — enables one-level undo.
  state.lastNote = { filePath: state.activePhoto.filePath, previousNote: pm.note || '' };
  el.undoNoteBtn.classList.remove('hidden');

  pm.note = el.photoNotes.value;
  await saveMetadata();

  el.noteSavedMsg.classList.remove('hidden');
  setTimeout(() => el.noteSavedMsg.classList.add('hidden'), 2500);

  // Refresh the list so the 📝 badge appears/disappears.
  renderPhotoList();
}

/*
 * Restores the note to its state before the last Save Note.
 * One level only — the undo button hides itself after use.
 */
async function handleUndoNote() {
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

// ─── Bad GPS Flag ──────────────────────────────────────────────────────────────

/*
 * Responds to the "Mark GPS as incorrect" checkbox toggle.
 * Updates the metadata file and refreshes the map marker to use the warning pin.
 */
async function handleBadGpsToggle() {
  if (!state.activePhoto) return;
  const pm = getPhotoMeta(state.activePhoto.filePath);
  pm.badGps = el.badGpsCheckbox.checked;
  await saveMetadata();
  refreshMarkerPin(state.activePhoto.filePath);
}

// ─── Per-Photo Pin Color ───────────────────────────────────────────────────────

/*
 * Saves the per-photo pin color override and refreshes the marker.
 * This is called whenever the color picker changes.
 */
async function handlePhotoPinColorChange() {
  if (!state.activePhoto) return;
  const pm = getPhotoMeta(state.activePhoto.filePath);
  pm.pinColor = el.photoPinColor.value;
  await saveMetadata();
  refreshMarkerPin(state.activePhoto.filePath);
}

/*
 * Resets the per-photo pin color override so the global default is used.
 */
async function handleResetPinColor() {
  if (!state.activePhoto) return;
  const pm = getPhotoMeta(state.activePhoto.filePath);
  pm.pinColor = null;
  await saveMetadata();
  // Update the color picker to show the resolved global color now that the
  // per-photo override has been cleared. Done after save so the UI and disk
  // are always updated in the same order as handlePhotoPinColorChange.
  el.photoPinColor.value = resolveColor(state.activePhoto.filePath);
  refreshMarkerPin(state.activePhoto.filePath);
}

// ─── Rename ────────────────────────────────────────────────────────────────────

async function handleRename() {
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
  const resolvedName = result.newName;  // may differ from newName if deduplicated
  const resolvedExt  = getExtension(resolvedName);
  const resolvedBase = resolvedName.slice(0, -resolvedExt.length);

  // Capture a snapshot BEFORE updating state so undo can reverse everything.
  state.lastRename = {
    oldPath,
    oldName:      state.activePhoto.filename,
    newPath:      result.newPath,
    newName:      resolvedName,
    // Deep copy the current metadata entry so undo can restore it exactly.
    metaSnapshot: state.meta.photos[oldPath]
      ? JSON.parse(JSON.stringify(state.meta.photos[oldPath]))
      : null
  };
  el.undoRenameBtn.classList.remove('hidden');

  state.activePhoto.filePath = result.newPath;
  state.activePhoto.filename = resolvedName;

  // Rekey the in-memory metadata so it matches the new file path, then
  // immediately persist — this is the single authoritative write for the
  // rename.  All fields (note, badGps, pinColor, gpsOverride) travel with
  // the photo because state.meta is the source of truth, not the disk snapshot.
  if (state.meta.photos[oldPath] !== undefined) {
    state.meta.photos[result.newPath] = state.meta.photos[oldPath];
    delete state.meta.photos[oldPath];
  }
  await saveMetadata();

  const markerEntry = state.markers.find(m => m.data.filePath === oldPath);
  if (markerEntry) {
    markerEntry.data.filePath = result.newPath;
    markerEntry.data.filename = resolvedName;
    // marker is null for bad-GPS photos — guard before accessing
    if (markerEntry.marker) markerEntry.marker.options.title = resolvedName;
  }

  const photoEntry = state.photos.find(p => p.filePath === oldPath);
  if (photoEntry) { photoEntry.filePath = result.newPath; photoEntry.filename = resolvedName; }

  // Update the rename field to show the actual name used (in case it was deduplicated).
  el.renameInput.value     = resolvedBase;
  el.renameExt.textContent = resolvedExt;

  renderPhotoList();
  showRenameSuccess(resolvedName !== newName ? `✓ Renamed to "${resolvedName}"` : '✓ Renamed');
}

function showRenameError(msg)  { el.renameError.textContent = msg; el.renameError.classList.remove('hidden'); }
function hideRenameMessages()  { el.renameError.classList.add('hidden'); el.renameSuccess.classList.add('hidden'); }
function showRenameSuccess(msg = '✓ Renamed')   {
  el.renameSuccess.textContent = msg;
  el.renameSuccess.classList.remove('hidden');
  setTimeout(() => el.renameSuccess.classList.add('hidden'), 3000);
}

// ─── Undo Rename ──────────────────────────────────────────────────────────────

/*
 * Undoes the last rename operation, restoring both the filename on disk and
 * the sidecar metadata (note, bad-GPS flag, pin color) to their pre-rename state.
 *
 * Only one level of undo is kept.  The button is shown after a successful rename
 * and hidden again once used (or when a new photo is opened).
 */
async function handleUndoRename() {
  const u = state.lastRename;
  if (!u) return;

  hideRenameMessages();

  // Re-rename the file back to its original name.
  const result = await window.photoMap.renameFile({
    oldPath:    u.newPath,
    newName:    u.oldName,
    folderPath: state.folderPath
  });

  if (!result.success) {
    // Undo failed — the file may have been moved or deleted externally.
    // Clear the undo record so the button doesn't offer a retry that will also fail.
    state.lastRename = null;
    el.undoRenameBtn.classList.add('hidden');
    showRenameError(`Undo failed: ${result.error}`);
    return;
  }

  // Restore the metadata entry under the original path.
  if (u.metaSnapshot !== null) {
    state.meta.photos[u.oldPath] = u.metaSnapshot;
  }
  // Remove the entry under the renamed path (the rename IPC already moved it
  // back on disk; now we sync the in-memory mirror).
  delete state.meta.photos[u.newPath];
  await saveMetadata();

  // Sync all in-memory state back to the original path/name.
  if (state.activePhoto?.filePath === u.newPath) {
    state.activePhoto.filePath = u.oldPath;
    state.activePhoto.filename = u.oldName;
    el.renameInput.value = u.oldName.slice(0, -getExtension(u.oldName).length);
    el.renameExt.textContent = getExtension(u.oldName);
  }

  const markerEntry = state.markers.find(m => m.data.filePath === u.newPath);
  if (markerEntry) {
    markerEntry.data.filePath = u.oldPath;
    markerEntry.data.filename = u.oldName;
    if (markerEntry.marker) markerEntry.marker.options.title = u.oldName;
  }

  const photoEntry = state.photos.find(p => p.filePath === u.newPath);
  if (photoEntry) { photoEntry.filePath = u.oldPath; photoEntry.filename = u.oldName; }

  // Clear the undo record and hide the button — one level only.
  state.lastRename = null;
  el.undoRenameBtn.classList.add('hidden');

  renderPhotoList();
  showRenameSuccess('↩ Undone');
}

// ─── Lightbox (photo zoom) ─────────────────────────────────────────────────────

/*
 * Opens the full-screen lightbox for the currently active photo.
 * Supports scroll-to-zoom and click-drag pan.
 */
function openLightbox() {
  if (!state.activePhoto) return;
  const ext = getExtension(state.activePhoto.filename).toLowerCase();
  const url = BROWSER_IMAGE_FORMATS.has(ext)
    ? window.photoMap.filePathToUrl(state.activePhoto.filePath)
    : el.photoThumbnail.dataset.url;
  if (!url) return;

  el.lightboxImg.src    = url;
  el.lightboxCaption.textContent = state.activePhoto.filename;
  state.lightboxScale   = 1;
  state.lightboxOrigin  = { x: 0, y: 0 };
  applyLightboxTransform();

  el.lightbox.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  el.lightbox.classList.add('hidden');
  el.lightbox.classList.remove('above-qr');
  document.body.style.overflow = '';
  el.lightboxImg.src = '';
}

/*
 * Applies the current scale and pan offset to the lightbox image.
 */
function applyLightboxTransform() {
  el.lightboxImg.style.transform =
    `translate(${state.lightboxOrigin.x}px, ${state.lightboxOrigin.y}px) scale(${state.lightboxScale})`;
}

/*
 * Handles mouse-wheel scroll inside the lightbox to zoom in/out.
 * Scroll up = zoom in, scroll down = zoom out.
 */
function handleLightboxWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.85 : 1.18;
  state.lightboxScale = Math.min(10, Math.max(0.5, state.lightboxScale * delta));
  applyLightboxTransform();
}

/*
 * Handles click-drag panning inside the lightbox.
 */
function setupLightboxDrag() {
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

  // Close when clicking the dark backdrop around the photo. The image has
  // pointer-events:none so all clicks land on lightboxInner; use the image's
  // bounding rect to distinguish backdrop from photo.
  el.lightboxInner.addEventListener('click', (e) => {
    const r = el.lightboxImg.getBoundingClientRect();
    const onPhoto = e.clientX >= r.left && e.clientX <= r.right &&
                    e.clientY >= r.top  && e.clientY <= r.bottom;
    if (!onPhoto) closeLightbox();
  });
}

// ─── Resizable Sidebar ─────────────────────────────────────────────────────────

/*
 * Applies a sidebar width (in pixels) to both the panel and the resize handle.
 * The handle is positioned absolutely at the left edge of the panel, so it must
 * be updated whenever the width changes — including on initial load, otherwise
 * the handle appears at the CSS default position rather than the saved width.
 *
 * Input: w — desired sidebar width in pixels
 */
function applySidebarWidth(w) {
  const clamped = Math.min(600, Math.max(260, w));
  state.sidebarWidth = clamped;
  el.infoPanel.style.width    = clamped + 'px';
  // The handle uses CSS `right` to stay glued to the left edge of the panel.
  // We must keep this in sync manually whenever the panel width changes.
  el.resizeHandle.style.right = clamped + 'px';
}

/*
 * Sets up the drag-to-resize interaction on the handle between map and sidebar.
 * The user grabs the thin handle and drags left/right to resize the sidebar.
 */
function setupSidebarResize() {
  let startX = 0;
  let startW = 0;

  el.resizeHandle.addEventListener('mousedown', (e) => {
    state.isResizing = true;
    startX = e.clientX;
    startW = state.sidebarWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.isResizing) return;
    // Dragging left increases width; dragging right decreases it.
    const delta = startX - e.clientX;
    applySidebarWidth(startW + delta);
    state.map?.invalidateSize();
  });

  window.addEventListener('mouseup', () => {
    if (!state.isResizing) return;
    state.isResizing = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    // Save the new sidebar width so it's remembered on next launch.
    window.photoMap.saveSettings({ sidebarWidth: state.sidebarWidth });
  });
}

// ─── Map Labels ────────────────────────────────────────────────────────────────

function renderAllLabels() {
  for (const labelData of state.meta.labels) {
    createLabelMarker(labelData);
  }
}

function createLabelMarker(labelData) {
  const fontSize = LABEL_FONT_SIZES[labelData.size] || '16px';
  const icon = L.divIcon({
    className: '',
    html: `<div class="map-label" style="font-size:${fontSize}">${escapeHtml(labelData.text)}</div>`,
    iconSize: null,
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

function toggleLabelPlacementMode() {
  state.placingLabel = !state.placingLabel;
  el.addLabelBtn.classList.toggle('active', state.placingLabel);
  el.mapDiv.style.cursor = state.placingLabel ? 'crosshair' : '';
  el.addLabelBtn.textContent = state.placingLabel ? '✕ Cancel' : '+ Label';
  if (state.placingLabel) closeLabelPopup();
}

function showLabelPopupAtLatLng(latLng) {
  state.placingLabel = false;
  el.addLabelBtn.textContent = '+ Label';
  el.addLabelBtn.classList.remove('active');
  el.mapDiv.style.cursor = '';

  state.pendingLabelLatLng = latLng;
  state.editingLabelId = null;

  el.labelTextInput.value  = '';
  el.labelSizeSelect.value = 'medium';
  el.labelPopupTitle.textContent = 'New Label';
  el.saveLabelBtn.textContent    = 'Place Label';
  el.deleteLabelBtn.classList.add('hidden');

  // latLngToContainerPoint returns coords relative to the map div's top-left.
  // The popup is positioned absolutely inside #app-body, so we must add the
  // map div's offset relative to #app-body (non-zero when the list panel is open).
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

/*
 * Opens the label popup pre-filled for editing an existing label.
 * The delete button is shown (hidden when adding a new label).
 * The popup is centred on screen rather than positioned near a click point.
 *
 * Input: labelData — the label object { id, lat, lng, text, size }
 */
function openEditLabelPopup(labelData) {
  state.editingLabelId     = labelData.id;
  state.pendingLabelLatLng = { lat: labelData.lat, lng: labelData.lng };

  el.labelTextInput.value      = labelData.text;
  el.labelSizeSelect.value     = labelData.size;
  el.labelPopupTitle.textContent = 'Edit Label';
  el.saveLabelBtn.textContent    = 'Save Changes';
  el.deleteLabelBtn.classList.remove('hidden');

  el.labelPopup.style.left      = '50%';
  el.labelPopup.style.top       = '30%';
  el.labelPopup.style.transform = 'translate(-50%, 0)';

  el.labelPopup.classList.remove('hidden');
  el.labelTextInput.focus();
}

async function handleSaveLabel() {
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
          iconSize: null,
          iconAnchor: [0, 0]
        }));
        me.labelData.text = text; me.labelData.size = size;
      }
    }
  } else {
    const id  = 'label_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat;
    const lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng;
    const newLabel = { id, lat, lng, text, size };
    state.meta.labels.push(newLabel);
    createLabelMarker(newLabel);
  }

  await saveMetadata();
  closeLabelPopup();
}

async function handleDeleteLabel() {
  if (!state.editingLabelId) return;
  const mi = state.labelMarkers.findIndex(m => m.labelData.id === state.editingLabelId);
  if (mi !== -1) { state.labelMarkers[mi].marker.remove(); state.labelMarkers.splice(mi, 1); }
  state.meta.labels = state.meta.labels.filter(l => l.id !== state.editingLabelId);
  await saveMetadata();
  closeLabelPopup();
}

function closeLabelPopup() {
  el.labelPopup.classList.add('hidden');
  el.labelPopup.style.transform = '';
  state.editingLabelId = null; state.pendingLabelLatLng = null;
}

/*
 * Sets label visibility to the given boolean and updates all markers.
 * Called from the settings panel checkbox.
 */
function setLabelsVisibility(visible) {
  state.labelsVisible = visible;
  for (const { marker } of state.labelMarkers) {
    if (visible) {
      if (!state.map.hasLayer(marker)) marker.addTo(state.map);
    } else {
      if (state.map.hasLayer(marker)) marker.remove();
    }
  }
}

// ─── Settings Panel ────────────────────────────────────────────────────────────

function openSettingsPanel() {
  el.settingsApiKey.value      = state.apiKey;
  el.settingsFolder.value      = state.folderPath;
  el.settingsRecursive.checked = state.recursive;
  el.settingsShowLabels.checked = state.labelsVisible;
  el.settingsPinColor.value    = state.meta.pinColor || state.pinColor;
  el.settingsMessage.classList.add('hidden');
  el.settingsOverlay.classList.remove('hidden');
}

function closeSettingsPanel() { el.settingsOverlay.classList.add('hidden'); }

function showSettingsMessage(msg, type = 'success') {
  el.settingsMessage.textContent = msg;
  el.settingsMessage.className   = `settings-message ${type}`;
  el.settingsMessage.classList.remove('hidden');
}

async function handleSaveSettings() {
  const newApiKey    = el.settingsApiKey.value.trim();
  const newFolder    = el.settingsFolder.value.trim();
  const newRecursive = el.settingsRecursive.checked;
  const newPinColor  = el.settingsPinColor.value;
  const newShowLabels = el.settingsShowLabels.checked;

  if (!newApiKey)  { showSettingsMessage('API key cannot be empty.',      'error'); return; }
  if (!newFolder)  { showSettingsMessage('Please select a photo folder.', 'error'); return; }

  // Apply label visibility immediately — no reload needed for this.
  setLabelsVisibility(newShowLabels);

  // If only label visibility changed, apply it and close without reloading.
  const apiKeyUnchanged   = newApiKey   === state.apiKey;
  const folderUnchanged   = newFolder   === state.folderPath;
  const recursiveUnchanged = newRecursive === state.recursive;
  // Normalise both colors to lowercase hex before comparing — the color picker
  // always returns a 6-digit lowercase hex string, but stored values may differ.
  const storedColor       = (state.meta.pinColor || state.pinColor || '#4f8ef7').toLowerCase();
  const colorUnchanged    = newPinColor.toLowerCase() === storedColor;
  if (apiKeyUnchanged && folderUnchanged && recursiveUnchanged && colorUnchanged) {
    // Label visibility is the only thing that changed (or nothing changed).
    // It is runtime-only state and intentionally not persisted to disk — it
    // resets to 'visible' on each launch, which is the expected default.
    closeSettingsPanel();
    return;
  }

  await window.photoMap.saveSettings({
    apiKey: newApiKey, folderPath: newFolder, recursive: newRecursive, pinColor: newPinColor
  });

  // Save global pin color into the metadata file so it travels with the photos.
  state.meta.pinColor = newPinColor;
  await saveMetadata();

  // Release the current folder's lock before reloading — the new session will
  // re-acquire it for whichever folder was saved.
  await window.photoMap.releaseLock(state.folderPath);

  // Skip the setup/welcome screen when reloading after a settings change.
  // The user is already authenticated — the setup screen is only for first launch.
  // We signal the next session to go straight to the app by setting a one-shot flag.
  sessionStorage.setItem('skipSetup', '1');

  window.location.reload();
}

// ─── All event bindings ────────────────────────────────────────────────────────

/*
 * Binds all event listeners for the main app view (toolbar, info panel,
 * settings, Quick Rename, lightbox, label popup, sidebar resize, and lock screen).
 * Called once during init() before the Leaflet map loads.
 */
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

  // Photo list search
  el.listSearch.addEventListener('input', renderPhotoList);

  // Photo list filter buttons — All / Bad GPS / Has Note.
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
    if (e.key === 'Enter') handleRename();
    if (e.key === 'Escape') closeInfoPanel();
  });
  el.showInFinderBtn.addEventListener('click', () => {
    if (state.activePhoto) window.photoMap.showInFolder(state.activePhoto.filePath);
  });
  el.undoRenameBtn.addEventListener('click', handleUndoRename);
  // Cmd/Ctrl+Z triggers undo when the info panel is open and a rename exists.
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

  // Zoom button
  el.zoomBtn.addEventListener('click', openLightbox);
  el.photoThumbnail.addEventListener('dblclick', openLightbox);

  // Lightbox
  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => {
    if (e.target === el.lightbox || e.target === el.lightboxCaption) closeLightbox();
  });
  el.lightboxInner.addEventListener('wheel', handleLightboxWheel, { passive: false });
  setupLightboxDrag();
  document.addEventListener('keydown', (e) => {
    // Escape closes overlays in priority order.
    if (e.key === 'Escape') {
      if (!el.lightbox.classList.contains('hidden'))        { closeLightbox();     return; }
      if (!el.readmeOverlay.classList.contains('hidden'))   { closeReadme();       return; }
      if (!qrEl.overlay.classList.contains('hidden'))       { closeQuickRename();  return; }
      closeInfoPanel();
    }

    // ← / → navigates the photo list when the info panel is open.
    // Skipped when focus is inside a text field to avoid hijacking typing.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (el.infoPanel.classList.contains('hidden'))        return;
      if (!el.lightbox.classList.contains('hidden'))        return;
      if (!qrEl.overlay.classList.contains('hidden'))       return;
      e.preventDefault();
      navigatePhoto(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  // Sidebar resize
  setupSidebarResize();

  // Settings
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

  // Label popup
  el.saveLabelBtn.addEventListener('click', handleSaveLabel);
  el.deleteLabelBtn.addEventListener('click', handleDeleteLabel);
  el.closeLabelPopupBtn.addEventListener('click', closeLabelPopup);
  el.labelTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveLabel();
    if (e.key === 'Escape') closeLabelPopup();
  });

  // Auth error
  el.authErrorSettingsLink.addEventListener('click', (e) => { e.preventDefault(); openSettingsPanel(); });

  // Backdrop closes settings
  el.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === el.settingsOverlay) closeSettingsPanel();
  });

  // README viewer
  el.closeReadmeBtn.addEventListener('click', closeReadme);
  el.readmeOverlay.addEventListener('click', (e) => {
    if (e.target === el.readmeOverlay) closeReadme();
  });

  // Lock error overlay buttons
  el.lockRetryBtn.addEventListener('click', async () => {
    // Re-attempt to acquire the lock — the previous holder may have closed the app.
    const result = await window.photoMap.acquireLock(state.folderPath);
    if (result.success) {
      hideLockError();
      showScreen('app');
      setFolderName(state.folderPath);
      launchMap();
    } else {
      // Still locked — refresh the detail message with up-to-date info.
      showLockError(result, state.folderPath);
    }
  });

  el.lockSettingsBtn.addEventListener('click', () => {
    // Let the user pick a different folder.
    hideLockError();
    showScreen('setup');
  });
}

// ─── Quick Rename ──────────────────────────────────────────────────────────────
//
// Two-column full-screen mode:
//   Left (480px) — mini satellite map (top) + notes + bad-GPS toggle (bottom)
//   Right (flex) — large photo thumbnail + rename bar pinned to bottom
//
// Keyboard shortcuts (active when any Quick Rename input has focus):
//   Enter          — save the new name if changed, auto-save the note, advance
//                    to next photo.  If the name is unchanged, same as Skip.
//   Tab            — toggle the bad-GPS flag for the current photo
//   Cmd/Ctrl+Enter — save the note without advancing (from the notes textarea)
//   Esc            — exit Quick Rename (handled in the global keydown listener)
//
// Mouse:
//   Skip → button  — advance without renaming
//   ⤢ button or double-click photo — open the zoom lightbox on top of Quick Rename

const qr = {
  photos:        [],     // all photos sorted alphabetically
  index:         0,      // current position
  loading:       false,  // guard against double-advance during async thumbnail load
  miniMap:       null,   // L.Map instance for the left panel
  miniMarker:    null,   // L.Marker for the current photo's pin
  miniMapLabels: [],     // L.Markers mirroring the main map's labels.
                         // Rebuilt every time Quick Rename opens so new/deleted
                         // labels are always reflected correctly.
  lastState:     null,   // Snapshot for undo: { index, filePath, filename, metaSnapshot }
                         // Captured before advancing so ↩ Undo can restore the previous photo.
  lastNoteState: null    // Snapshot for note undo: { prevNote } — stored here rather than
                         // in a DOM dataset attribute to keep state out of the DOM.
};

const qrEl = {
  overlay:       document.getElementById('quick-rename-overlay'),
  closeBtn:      document.getElementById('qr-close-btn'),
  counter:       document.getElementById('qr-counter'),
  mapDiv:        document.getElementById('qr-map'),
  coords:        document.getElementById('qr-coords'),
  img:           document.getElementById('qr-photo-img'),
  loading:       document.getElementById('qr-loading'),
  zoomBtn:       document.getElementById('qr-zoom-btn'),
  nameInput:     document.getElementById('qr-name-input'),
  extSpan:       document.getElementById('qr-ext'),
  saveBtn:       document.getElementById('qr-save-btn'),
  skipBtn:       document.getElementById('qr-skip-btn'),
  undoBtn:       document.getElementById('qr-undo-btn'),
  error:         document.getElementById('qr-error'),
  notes:         document.getElementById('qr-notes'),
  saveNoteBtn:   document.getElementById('qr-save-note-btn'),
  undoNoteBtn:   document.getElementById('qr-undo-note-btn'),
  noteSaved:     document.getElementById('qr-note-saved'),
  badGpsChk:     document.getElementById('qr-bad-gps-checkbox'),
  badGpsLabel:   document.getElementById('qr-bad-gps-label')
};

/*
 * Opens Quick Rename mode.
 */
function openQuickRename() {
  if (!state.photos.length) { setStatus('No photos to rename.'); return; }

  qr.photos = [...state.photos]
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }));

  qr.index   = 0;
  qr.loading = false;

  qrEl.overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Initialise the mini map once (Leaflet is always available).
  // invalidateSize() is called unconditionally below so the map always
  // gets correct dimensions after the overlay becomes visible.
  if (!qr.miniMap) {
    qr.miniMap = L.map(qrEl.mapDiv, {
      zoom:             18,
      center:           [20, 0],
      zoomControl:      false,
      attributionControl: true
    });
    L.tileLayer(
      `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=${state.apiKey}`,
      {
        tileSize:    512,
        zoomOffset:  -1,
        maxZoom:     22,
        attribution: MAPTILER_ATTRIBUTION,
        crossOrigin: true
      }
    ).addTo(qr.miniMap);
  }

  // Rebuild the label markers on the mini map every time Quick Rename opens
  // so that any labels added or deleted since the last session are reflected.
  for (const m of qr.miniMapLabels) m.remove();
  qr.miniMapLabels = [];

  for (const { labelData } of state.labelMarkers) {
    const fontSize = LABEL_FONT_SIZES[labelData.size] || '16px';
    const m = L.marker([labelData.lat, labelData.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="map-label" style="font-size:${fontSize}">${escapeHtml(labelData.text)}</div>`,
        iconSize: null,
        iconAnchor: [0, 0]
      })
    }).addTo(qr.miniMap);
    qr.miniMapLabels.push(m);
  }

  // Tell Leaflet the mini map container now has its final dimensions.
  // Must run after the overlay is visible so getBoundingClientRect is non-zero.
  qr.miniMap.invalidateSize();

  // Bind events once.
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

    // Click on the bad GPS label area also toggles (provides a larger hit target).
    qrEl.badGpsLabel.addEventListener('click', (e) => {
      // The checkbox fires its own change event; we only need to handle
      // clicks that land on the label text, not the checkbox itself.
      if (e.target !== qrEl.badGpsChk) {
        qrEl.badGpsChk.checked = !qrEl.badGpsChk.checked;
        qrToggleBadGps();
      }
    });

    qrEl.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); qrSaveAndNext(); }
      if (e.key === 'Tab')   { e.preventDefault(); qrEl.badGpsChk.checked = !qrEl.badGpsChk.checked; qrToggleBadGps(); }
      // Escape is handled globally in the main keydown listener.
    });

    // Notes textarea: Cmd/Ctrl+Enter saves the note without advancing.
    // Plain Enter advances to the next photo. Tab toggles bad GPS.
    qrEl.notes.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); qrSaveNote(); return; }
      if (e.key === 'Enter') { e.preventDefault(); qrSaveAndNext(); }
      if (e.key === 'Tab')   { e.preventDefault(); qrEl.badGpsChk.checked = !qrEl.badGpsChk.checked; qrToggleBadGps(); }
    });

    qrEl.overlay.dataset.bound = 'true';
  }

  qrLoadPhoto(0);
}

/*
 * Loads the photo at index idx into the Quick Rename UI.
 * Updates the counter, thumbnail, mini map, notes, and bad-GPS checkbox.
 */
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

  // Counter
  qrEl.counter.textContent = `${idx + 1} / ${qr.photos.length}`;

  // Filename input
  qrEl.error.classList.add('hidden');
  qrEl.nameInput.value     = base;
  qrEl.extSpan.textContent = ext;

  // Notes
  qrEl.notes.value = pm.note || '';
  qrEl.noteSaved.classList.add('hidden');
  qrEl.undoNoteBtn.classList.add('hidden');
  qr.lastNoteState = null;

  // Bad GPS checkbox — reflect current flag and style the label accordingly.
  qrEl.badGpsChk.checked = pm.badGps === true;
  qrEl.badGpsLabel.classList.toggle('is-flagged', pm.badGps === true);

  // Coordinates — use override if set, fall back to EXIF, else show none.
  const effLat = pm.gpsOverride ? pm.gpsOverride.lat : photo.lat;
  const effLng = pm.gpsOverride ? pm.gpsOverride.lng : photo.lng;
  qrEl.coords.textContent = (effLat != null && effLng != null)
    ? `${effLat.toFixed(5)}, ${effLng.toFixed(5)}`
    : 'No GPS data';

  // Mini map — only position when coords are available.
  if (qr.miniMap) {
    if (effLat != null && effLng != null) {
      const pos = [effLat, effLng];
      qr.miniMap.setView(pos, 18, { animate: false });
      if (qr.miniMarker) {
        qr.miniMarker.setLatLng(pos);
        qr.miniMarker.setIcon(createPinIcon(resolveColor(photo.filePath)));
      } else {
        qr.miniMarker = L.marker(pos, {
          icon: createPinIcon(resolveColor(photo.filePath))
        }).addTo(qr.miniMap);
      }
    } else {
      // No location — hide the mini marker if one exists from a previous photo.
      if (qr.miniMarker) { qr.miniMarker.remove(); qr.miniMarker = null; }
    }
  }

  // Thumbnail
  qrEl.img.style.opacity     = '0';
  qrEl.zoomBtn.classList.add('hidden');
  qrEl.loading.style.display = 'flex';
  qrEl.loading.textContent   = 'Loading…';

  const qrUrl = await resolvePhotoDisplayUrl(photo.filePath, photo.filename);

  // Guard against stale loads: if the user advanced to another photo while
  // this thumbnail was decoding (slow HEIC), discard the result silently.
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

/*
 * Saves the note for the current photo to state.meta and disk.
 * Does not advance to the next photo.
 */
async function qrSaveNote() {
  const photo = qr.photos[qr.index];
  if (!photo) return;
  const pm = getPhotoMeta(photo.filePath);

  // Snapshot the previous note before overwriting.
  const prevNote = pm.note || '';
  pm.note = qrEl.notes.value;
  await saveMetadata();

  // Store the previous note in qr state (not in a DOM dataset) so qrUndoNote
  // can restore it — keeping program state out of the DOM.
  qr.lastNoteState = { prevNote };
  qrEl.undoNoteBtn.classList.remove('hidden');

  qrEl.noteSaved.classList.remove('hidden');
  setTimeout(() => qrEl.noteSaved.classList.add('hidden'), 2000);
  renderPhotoList();
}

/*
 * Restores the note to its state before the last QR Save Note.
 */
async function qrUndoNote() {
  const photo = qr.photos[qr.index];
  if (!photo) return;
  const prevNote = qr.lastNoteState?.prevNote ?? '';
  const pm = getPhotoMeta(photo.filePath);
  pm.note = prevNote;
  qrEl.notes.value = prevNote;
  await saveMetadata();
  qrEl.undoNoteBtn.classList.add('hidden');
  qrEl.noteSaved.classList.add('hidden');
  renderPhotoList();
}

/*
 * Toggles the bad-GPS flag for the current photo.
 * Called by the checkbox change event, the Tab hotkey, and clicking the label.
 */
async function qrToggleBadGps() {
  const photo = qr.photos[qr.index];
  if (!photo) return;
  const pm = getPhotoMeta(photo.filePath);
  pm.badGps = qrEl.badGpsChk.checked;
  qrEl.badGpsLabel.classList.toggle('is-flagged', pm.badGps);
  await saveMetadata();
  refreshMarkerPin(photo.filePath);
}

/*
 * Flushes any unsaved note text for the current Quick Rename photo to disk.
 * Called before advancing to the next photo (either by saving or skipping)
 * so that note edits are never lost during a session.
 * Shared by qrSaveAndNext and qrSkip to avoid duplicating the same logic.
 *
 * Also captures a snapshot of the current photo's state before any changes,
 * which is used by qrUndo to reverse the advance and restore the previous state.
 */
async function qrFlushNote() {
  const photo = qr.photos[qr.index];
  if (!photo) return;

  // Snapshot the current photo's state BEFORE writing anything.
  // Deep-copy the metadata so the undo can restore it even if subsequent
  // saves overwrite it while working on later photos.
  qr.lastState = {
    index:        qr.index,
    filePath:     photo.filePath,
    filename:     photo.filename,
    metaSnapshot: state.meta.photos[photo.filePath]
      ? JSON.parse(JSON.stringify(state.meta.photos[photo.filePath]))
      : null,
    noteText:     qrEl.notes.value
  };
  // Only offer undo if there's a previous photo to go back to.
  if (qr.index > 0) qrEl.undoBtn.classList.remove('hidden');

  const pm          = getPhotoMeta(photo.filePath);
  const currentNote = qrEl.notes.value;
  if (currentNote !== (pm.note || '')) {
    pm.note = currentNote;
    await saveMetadata();
    renderPhotoList();
  }
}

/*
 * Saves the new filename (if changed) and advances to the next photo.
 * Always flushes the note before moving on (via qrFlushNote, which also
 * captures a snapshot for undo before writing anything).
 */
async function qrSaveAndNext() {
  if (qr.loading) return;

  const photo   = qr.photos[qr.index];
  const ext     = qrEl.extSpan.textContent;
  const newBase = qrEl.nameInput.value.trim();
  const newName = newBase + ext;

  qrEl.error.classList.add('hidden');
  await qrFlushNote();

  if (newName === photo.filename) { qrLoadPhoto(qr.index + 1); return; } // note already flushed above

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

  // Rekey and persist — same single-source-of-truth approach as handleRename.
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

  // Update the name input so it reflects the actual name used.
  const resolvedExt  = getExtension(resolvedName);
  qrEl.nameInput.value   = resolvedName.slice(0, -resolvedExt.length);
  qrEl.extSpan.textContent = resolvedExt;

  renderPhotoList();
  qrLoadPhoto(qr.index + 1);
}

/*
 * Skips the current photo without renaming. Always flushes the note first.
 */
async function qrSkip() {
  if (qr.loading) return;
  qrEl.error.classList.add('hidden');
  await qrFlushNote();
  qrLoadPhoto(qr.index + 1);
}

/*
 * Goes back to the previous photo in Quick Rename, restoring any filename
 * or sidecar changes (note, bad-GPS flag) that were made before advancing.
 * One level only — the undo button hides itself after use.
 *
 * If a rename happened, it is reversed on disk using the rename IPC.
 * The metadata snapshot captured in qrFlushNote is restored in memory
 * and written back to disk.
 */
async function qrUndo() {
  const u = qr.lastState;
  if (!u) return;

  const prevPhoto = qr.photos[u.index];
  if (!prevPhoto) return;

  qrEl.error.classList.add('hidden');

  // If the filename changed since we snapped the state, reverse the rename.
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
    // Sync all state to the restored filename.
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

  // Restore the metadata snapshot (note, bad-GPS, pin color).
  if (u.metaSnapshot !== null) {
    state.meta.photos[u.filePath] = u.metaSnapshot;
  } else {
    delete state.meta.photos[u.filePath];
  }
  await saveMetadata();
  renderPhotoList();

  // Clear the undo record and go back.
  qr.lastState = null;
  qrEl.undoBtn.classList.add('hidden');
  qrLoadPhoto(u.index);
}

/*
 * Opens the zoom lightbox from Quick Rename.
 */
function qrOpenZoom() {
  const photo = qr.photos[qr.index];
  if (!photo) return;
  const ext = getExtension(photo.filename).toLowerCase();
  const url = BROWSER_IMAGE_FORMATS.has(ext)
    ? window.photoMap.filePathToUrl(photo.filePath)
    : (qrEl.img.dataset.url || '');
  if (!url) return;
  el.lightboxImg.src = url;
  el.lightboxCaption.textContent = qr.photos[qr.index]?.filename || '';
  state.lightboxScale  = 1;
  state.lightboxOrigin = { x: 0, y: 0 };
  applyLightboxTransform();
  el.lightbox.classList.add('above-qr');
  el.lightbox.classList.remove('hidden');
}

/*
 * Exits Quick Rename and restores normal app state.
 */
function closeQuickRename() {
  qrEl.overlay.classList.add('hidden');
  document.body.style.overflow = '';
  qrEl.img.src = '';
  qrEl.img.dataset.url = '';
  if (state.activePhoto) openInfoPanel(state.activePhoto);
}

// ─── Export ───────────────────────────────────────────────────────────────────

/*
 * Exports all GPS photos and their annotations to GeoJSON or CSV.
 * Both formats are generated by the main process (which has filesystem access)
 * but we pass the in-memory photos array and metadata so the export reflects
 * the current session state without needing a re-scan.
 *
 * Input: format — 'geojson' or 'csv'
 */
async function handleExport(format) {
  const exportPhotos = state.photos
    .map(p => {
      const pm = getPhotoMeta(p.filePath);
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
    result = await window.photoMap.exportData({
      photos:   exportPhotos,
      metadata: state.meta,
      format
    });
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

// ─── README Viewer ─────────────────────────────────────────────────────────────

/*
 * Opens the README viewer overlay and renders the README.md file as HTML.
 * Markdown is converted to HTML using a lightweight parser built in below —
 * no external library needed.  The result is read-only; no editing is possible.
 */
async function openReadme() {
  el.readmeBody.innerHTML = '<p class="readme-loading">Loading…</p>';
  el.readmeOverlay.classList.remove('hidden');

  const result = await window.photoMap.readReadme();

  if (!result.success) {
    el.readmeBody.innerHTML = `<p class="readme-error">Could not load README: ${escapeHtml(result.error)}</p>`;
    return;
  }

  el.readmeBody.innerHTML = markdownToHtml(result.text);

  // Scroll back to the top whenever the viewer opens.
  el.readmeBody.scrollTop = 0;
}

/*
 * Closes the README viewer overlay.
 */
function closeReadme() {
  el.readmeOverlay.classList.add('hidden');
}

/*
 * Converts a subset of Markdown to safe HTML for display inside the app.
 * Handles: headings, bold, inline code, fenced code blocks, horizontal rules,
 * unordered lists, ordered lists, blockquotes, GFM tables, and [links](url).
 *
 * Input:  md — a Markdown string
 * Returns: an HTML string safe to set as innerHTML
 */
function markdownToHtml(md) {
  const lines = md.split('\n');
  const out   = [];
  let inCodeBlock   = false;
  let inList        = false;
  let inOrderedList = false;
  let inTable       = false;
  let tableLines    = [];
  let codeLang      = '';
  let codeLines     = [];

  /*
   * Converts raw (unescaped) inline text to safe HTML.
   * Processes tokens left-to-right so backtick spans take priority over links,
   * and links take priority over bold markers.
   */
  function inlineFormat(raw) {
    let result = '';
    let i = 0;
    let textStart = 0;

    function flushPlain(end) {
      if (end > textStart) result += escapeHtml(raw.slice(textStart, end));
      textStart = end;
    }

    while (i < raw.length) {
      // Inline code: `text`
      if (raw[i] === '`') {
        const end = raw.indexOf('`', i + 1);
        if (end !== -1) {
          flushPlain(i);
          result += `<code class="md-inline-code">${escapeHtml(raw.slice(i + 1, end))}</code>`;
          i = end + 1; textStart = i; continue;
        }
      }
      // Link: [text](url)
      if (raw[i] === '[') {
        const cb = raw.indexOf(']', i + 1);
        if (cb !== -1 && raw[cb + 1] === '(') {
          const cp = raw.indexOf(')', cb + 2);
          if (cp !== -1) {
            flushPlain(i);
            const linkText = raw.slice(i + 1, cb);
            const url      = raw.slice(cb + 2, cp);
            const safeUrl  = /^https?:|^mailto:/i.test(url) ? url : '#';
            result += `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkText)}</a>`;
            i = cp + 1; textStart = i; continue;
          }
        }
      }
      // Bold: **text**
      if (raw[i] === '*' && raw[i + 1] === '*') {
        const end = raw.indexOf('**', i + 2);
        if (end !== -1) {
          flushPlain(i);
          result += `<strong>${escapeHtml(raw.slice(i + 2, end))}</strong>`;
          i = end + 2; textStart = i; continue;
        }
      }
      i++;
    }
    flushPlain(i);
    return result;
  }

  function flushList() {
    if (inList)        { out.push('</ul>'); inList        = false; }
    if (inOrderedList) { out.push('</ol>'); inOrderedList = false; }
  }

  function flushTable() {
    if (!inTable) return;
    inTable = false;
    const rows = tableLines;
    tableLines = [];
    if (rows.length < 2) {
      rows.forEach(r => out.push(`<p class="md-p">${inlineFormat(r)}</p>`));
      return;
    }
    const parseRow = line => line.split('|').slice(1, -1).map(c => c.trim());
    const isSep    = cells => cells.length > 0 && cells.every(c => /^[-: ]+$/.test(c));
    const headers  = parseRow(rows[0]);
    if (!isSep(parseRow(rows[1]))) {
      rows.forEach(r => out.push(`<p class="md-p">${inlineFormat(r)}</p>`));
      return;
    }
    let html = '<table class="md-table"><thead><tr>';
    headers.forEach(c => { html += `<th class="md-th">${inlineFormat(c)}</th>`; });
    html += '</tr></thead><tbody>';
    for (let j = 2; j < rows.length; j++) {
      html += '<tr>';
      parseRow(rows[j]).forEach(c => { html += `<td class="md-td">${inlineFormat(c)}</td>`; });
      html += '</tr>';
    }
    html += '</tbody></table>';
    out.push(html);
  }

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trimEnd();

    // ── Fenced code block ──────────────────────────────────────────────────
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        flushList(); flushTable();
        inCodeBlock = true;
        codeLang    = line.slice(3).trim();
        codeLines   = [];
      } else {
        const escaped  = codeLines.map(l => escapeHtml(l)).join('\n');
        const langAttr = codeLang ? ` class="md-code-lang-${escapeHtml(codeLang)}"` : '';
        out.push(`<pre class="md-code-block"><code${langAttr}>${escaped}</code></pre>`);
        inCodeBlock = false; codeLines = []; codeLang = '';
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(raw); continue; }

    // ── Blank line ─────────────────────────────────────────────────────────
    if (!line.trim()) { flushList(); flushTable(); continue; }

    // ── Table row ──────────────────────────────────────────────────────────
    if (line.trimStart().startsWith('|')) {
      flushList();
      inTable = true;
      tableLines.push(line);
      continue;
    }
    flushTable();

    // ── Headings ───────────────────────────────────────────────────────────
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h1) { flushList(); out.push(`<h1 class="md-h1">${inlineFormat(h1[1])}</h1>`); continue; }
    if (h2) { flushList(); out.push(`<h2 class="md-h2">${inlineFormat(h2[1])}</h2>`); continue; }
    if (h3) { flushList(); out.push(`<h3 class="md-h3">${inlineFormat(h3[1])}</h3>`); continue; }

    // ── Horizontal rule ────────────────────────────────────────────────────
    if (/^---+$/.test(line.trim())) { flushList(); out.push('<hr class="md-hr"/>'); continue; }

    // ── Blockquote ─────────────────────────────────────────────────────────
    const bq = line.match(/^> (.+)/);
    if (bq) {
      flushList();
      out.push(`<blockquote class="md-blockquote">${inlineFormat(bq[1])}</blockquote>`);
      continue;
    }

    // ── Unordered list ─────────────────────────────────────────────────────
    const li = line.match(/^[-*] (.+)/);
    if (li) {
      if (inOrderedList) { out.push('</ol>'); inOrderedList = false; }
      if (!inList) { out.push('<ul class="md-ul">'); inList = true; }
      out.push(`<li class="md-li">${inlineFormat(li[1])}</li>`);
      continue;
    }

    // ── Ordered list ───────────────────────────────────────────────────────
    const oli = line.match(/^\d+\. (.+)/);
    if (oli) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (!inOrderedList) { out.push('<ol class="md-ol">'); inOrderedList = true; }
      out.push(`<li class="md-li">${inlineFormat(oli[1])}</li>`);
      continue;
    }

    // ── Paragraph ──────────────────────────────────────────────────────────
    flushList();
    out.push(`<p class="md-p">${inlineFormat(line)}</p>`);
  }

  flushList();
  flushTable();
  if (inCodeBlock && codeLines.length) {
    out.push(`<pre class="md-code-block"><code>${codeLines.map(l => escapeHtml(l)).join('\n')}</code></pre>`);
  }

  return out.join('\n');
}

// ─── Lock Error Screen ─────────────────────────────────────────────────────────

/*
 * Shows the lock error overlay, blocking all app activity.
 * Populated with a human-readable explanation of why access is blocked,
 * including who holds the lock and when they opened it.
 *
 * Input: lockResult — the object returned by window.photoMap.acquireLock()
 *        folderPath — the folder that triggered the error
 */
function showLockError(lockResult, _folderPath) {
  if (lockResult.error === 'locked') {
    const lb = lockResult.lockedBy || {};

    el.lockTitle.textContent = 'Folder In Use';
    el.lockMessage.textContent =
      'Another instance of Photo Map has this folder open for editing. ' +
      'Only one person can edit annotations at a time to prevent data loss.';

    // Build the detail line — use fallbacks so something always shows
    // even if individual fields are missing or empty.
    const user    = lb.user    || 'unknown user';
    const machine = lb.machine || 'unknown machine';
    const when    = formatLockTimestamp(lb.timestamp);

    el.lockDetail.textContent = `Opened by: ${user} on ${machine} at ${when}`;
    el.lockDetail.classList.remove('hidden');

  } else if (lockResult.error === 'unwritable') {
    el.lockTitle.textContent = 'Folder is Read-Only';
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

/*
 * Formats a lock-file timestamp string for display in the error overlay.
 * Returns a friendly local time string, or a safe fallback if the value
 * is missing, malformed, or not a valid date.
 *
 * Input:  ts — an ISO 8601 timestamp string (e.g. "2026-05-09T14:32:00.000Z")
 * Returns: a human-readable string like "May 9, 2026, 2:32 PM"
 */
function formatLockTimestamp(ts) {
  if (!ts) return 'unknown time';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts; // return raw string if parsing failed
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  } catch {
    return ts;
  }
}

/*
 * Hides the lock error overlay.
 * Called when a retry succeeds or the user picks a different folder.
 */
function hideLockError() {
  el.lockOverlay.classList.add('hidden');
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function setStatus(msg) { el.statusText.textContent = msg; }

/*
 * Displays just the folder's own name (not its full path) in the toolbar center.
 * e.g. "/Users/sara/Downloads/Test photos North Carthage" → "Test photos North Carthage"
 * The full path is shown as a tooltip on hover.
 * Input: folderPath — the full path string from settings
 */
function setFolderName(folderPath) {
  if (!folderPath) return;
  // Split on both forward slash (Mac/Linux) and backslash (Windows) and take the last segment.
  const name = folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || folderPath;
  const span = document.getElementById('folder-name');
  if (span) {
    span.textContent = name;
    span.title = folderPath;   // show full path on hover
  }
}

function getExtension(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i);
}

/*
 * Formats an ISO date string into a long human-readable form for the info panel.
 * Example: "2024-03-15T10:30:00.000Z" → "March 15, 2024, 10:30 AM"
 * Use formatDateShort for compact list rows where space is limited.
 */
function formatDate(isoString) {
  try {
    return new Date(isoString).toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  } catch { return isoString; }
}

/*
 * Formats an ISO date string into a compact date-only form for the photo list rows.
 * Example: "2024-03-15T10:30:00.000Z" → "Mar 15, 2024"
 * Use formatDate for the full timestamp shown in the info panel.
 */
function formatDateShort(isoString) {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch { return escapeHtml(String(isoString)); }
}

// Safely converts a string so it can be placed in innerHTML without XSS.
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Validates a CSS color value is a safe hex string before use in style attributes.
// Only accepts #rgb, #rrggbb, and #rrggbbaa — the formats produced by <input type="color">.
// Any other value (could contain CSS injection) is replaced with the default blue.
function sanitizeColor(color) {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  return '#4f8ef7';
}

// ─── Start ─────────────────────────────────────────────────────────────────────

// Surface unhandled promise rejections in the status bar rather than silently
// swallowing them. Helps catch any async edge cases that slip past error handling.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection in renderer:', event.reason);
  setStatus(`⚠ Unexpected error: ${event.reason?.message || event.reason}`);
});

document.addEventListener('DOMContentLoaded', init);

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
 *   - Main map view: Google Maps satellite view, photo pin markers,
 *     freeform text labels, live folder watching
 *   - Photo list sidebar (left): searchable, filterable list of all GPS photos
 *     with ⚠ bad-GPS and 📝 note badges; filter by All / Bad GPS / Has Note
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
 *   acquire folder lock → save settings → load Google Maps → load metadata →
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
  markers:      [],          // [{ marker, data, pinEl }]  — pinEl is the PinElement
  labelMarkers: [],
  labelsVisible: true,

  activePhoto:     null,
  placingLabel:    false,
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

  // Photo list filter — 'all', 'bad', or 'note'
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
  authErrorSettingsLink:  document.getElementById('auth-error-settings-link'),

  // Lock error overlay
  lockOverlay:     document.getElementById('lock-overlay'),
  lockTitle:       document.getElementById('lock-title'),
  lockMessage:     document.getElementById('lock-message'),
  lockDetail:      document.getElementById('lock-detail'),
  lockRetryBtn:    document.getElementById('lock-retry-btn'),
  lockSettingsBtn: document.getElementById('lock-settings-btn'),

  // Status
  statusText: document.getElementById('status-text')
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
      loadGoogleMaps(state.apiKey);
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
}

async function handleSetupContinue() {
  const apiKey     = el.apiKeyInput.value.trim();
  const folderPath = el.folderPathInput.value.trim();
  if (!apiKey)     { showSetupError('Please enter your Google Maps API key.'); return; }
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
  loadGoogleMaps(apiKey);
}

function showSetupError(msg) { el.setupError.textContent = msg; el.setupError.classList.remove('hidden'); }
function hideSetupError()    { el.setupError.classList.add('hidden'); }

// ─── Google Maps ───────────────────────────────────────────────────────────────

function loadGoogleMaps(apiKey) {
  window.initMap = initMap;
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&libraries=marker&v=beta`;
  script.async = true; script.defer = true;
  script.onerror = showAuthError;
  document.head.appendChild(script);
  window.addEventListener('gm-authfailure', showAuthError);
}

function showAuthError() {
  el.authErrorBanner.classList.remove('hidden');
}

async function initMap() {
  state.map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 20, lng: 0 },
    zoom: 2,
    mapTypeId: 'satellite',
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
      position: google.maps.ControlPosition.TOP_RIGHT
    },
    mapId: 'photo-map-main'
  });

  state.map.addListener('click', (e) => {
    if (state.placingLabel) showLabelPopupAtLatLng(e.latLng);
  });

  // Load metadata from the photo folder before rendering anything.
  await loadMetadata();
  renderAllLabels();
  await scanAndDisplay();
  watchFolder();
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
    state.meta.photos[filePath] = { note: '', badGps: false, pinColor: null };
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
  placePhotoMarkers(result.photos);
  fitMapToMarkers();
  renderPhotoList();

  const errMsg = result.errors.length ? ` (${result.errors.length} errors)` : '';
  setStatus(`${result.totalScanned} photos scanned · ${result.totalWithGps} with GPS${errMsg}`);
}

/*
 * Creates map markers for every photo in the array.
 * Uses the global pin color unless the photo has its own color override.
 * Bad-GPS photos get a warning-styled pin.
 */
function placePhotoMarkers(photos) {
  for (const p of photos) createPhotoMarker(p);
}

/*
 * Resolves the correct pin color for a given photo.
 * Per-photo color → global meta color → app settings color → hardcoded default.
 */
function resolveColor(filePath) {
  const pm = state.meta.photos[filePath];
  return (pm && pm.pinColor) || state.meta.pinColor || state.pinColor || '#4f8ef7';
}

/*
 * Creates a single map marker for a photo.
 * Photos flagged as bad GPS are skipped — they are not shown on the map at all.
 * The entry is still pushed to state.markers (with marker.map = null) so the
 * info panel and photo list can still reach the photo's data; it just won't
 * appear as a pin on the map.
 */
function createPhotoMarker(photoData) {
  const pm    = getPhotoMeta(photoData.filePath);
  const isBad = pm.badGps === true;

  // Don't place a visible pin for photos with flagged GPS.
  if (isBad) {
    // Store a null-map entry so the photo is still reachable via the list.
    state.markers.push({ marker: { map: null, title: photoData.filename }, data: photoData, pinEl: null });
    return;
  }

  const pin = new google.maps.marker.PinElement({
    background:  resolveColor(photoData.filePath),
    borderColor: '#ffffff',
    glyphColor:  '#ffffff',
    glyph:       '📷'
  });

  const marker = new google.maps.marker.AdvancedMarkerElement({
    map:      state.map,
    position: { lat: photoData.lat, lng: photoData.lng },
    title:    photoData.filename,
    content:  pin.element
  });

  marker.addListener('click', () => openInfoPanel(photoData));
  state.markers.push({ marker, data: photoData, pinEl: pin });
}

/*
 * Responds to a change in pin color or bad-GPS flag for a single photo.
 * If the photo is now flagged as bad GPS, removes it from the map.
 * If the flag is cleared, adds it back as a normal pin.
 * If the color changed, rebuilds the pin element with the new color.
 */
function refreshMarkerPin(filePath) {
  const entry = state.markers.find(m => m.data.filePath === filePath);
  if (!entry) return;

  const pm    = getPhotoMeta(filePath);
  const isBad = pm.badGps === true;

  if (isBad) {
    // Remove from map if it's currently showing.
    if (entry.marker && typeof entry.marker.map !== 'undefined') {
      entry.marker.map = null;
    }
    entry.pinEl = null;
  } else {
    // Photo was either just un-flagged, or had its color changed.
    // If it already has an AdvancedMarkerElement, update its color and re-add to map.
    if (entry.pinEl) {
      // Existing real marker — just rebuild the pin element with the new color.
      const newPin = new google.maps.marker.PinElement({
        background: resolveColor(filePath), borderColor: '#ffffff',
        glyphColor: '#ffffff', glyph: '📷'
      });
      entry.marker.content = newPin.element;
      entry.pinEl = newPin;
      entry.marker.map = state.map;
    } else {
      // Was previously a null/bad-GPS entry — create a real marker now.
      const pin = new google.maps.marker.PinElement({
        background: resolveColor(filePath), borderColor: '#ffffff',
        glyphColor: '#ffffff', glyph: '📷'
      });
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map:      state.map,
        position: { lat: entry.data.lat, lng: entry.data.lng },
        title:    entry.data.filename,
        content:  pin.element
      });
      marker.addListener('click', () => openInfoPanel(entry.data));
      entry.marker = marker;
      entry.pinEl  = pin;
    }
  }

  renderPhotoList();
}

function clearPhotoMarkers() {
  for (const { marker } of state.markers) marker.map = null;
  state.markers = [];
}

/*
 * Adjusts the map zoom and centre so all visible photo markers fit on screen.
 * Bad-GPS entries are excluded — they have no pin on the map, so including
 * their coordinates would zoom to a position with nothing to see there.
 */
function fitMapToMarkers() {
  // Only consider markers that are actually visible on the map (pinEl != null).
  const visible = state.markers.filter(m => m.pinEl !== null);
  if (!visible.length) return;
  const bounds = new google.maps.LatLngBounds();
  for (const { data } of visible) bounds.extend({ lat: data.lat, lng: data.lng });
  state.map.fitBounds(bounds);
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
  if (!entry || !entry.pinEl) return; // bad-GPS entries have no visible pin
  entry.pinEl.element.classList.toggle('pin-selected', highlight);
}

/*
 * Renders the scrollable list of photos in the left sidebar.
 * Applies the current text search and category filter (All/Bad GPS/Has Note)
 * so only matching photos are shown. Clicking a row pans to that photo and
 * opens the info panel.
 */
function renderPhotoList() {
  const query = (el.listSearch.value || '').toLowerCase();
  const sorted = [...state.photos].sort((a, b) =>
    a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' })
  );

  el.photoListItems.innerHTML = '';

  for (const photo of sorted) {
    if (query && !photo.filename.toLowerCase().includes(query)) continue;

    // Apply the active filter button (All / Bad GPS / Has Note).
    // getPhotoMeta is called once and reused for both filtering and badge rendering.
    const pm    = getPhotoMeta(photo.filePath);
    if (state.listFilter === 'bad'  && !pm.badGps)          continue;
    if (state.listFilter === 'note' && !(pm.note?.trim()))   continue;

    const isBad   = pm.badGps === true;
    const hasNote = pm.note && pm.note.trim().length > 0;

    const row = document.createElement('div');
    row.className = 'list-row' + (state.activePhoto?.filePath === photo.filePath ? ' active' : '');
    row.dataset.filepath = photo.filePath;

    row.innerHTML = `
      <div class="list-row-name">
        ${isBad ? '<span class="badge badge-warn" title="GPS flagged as incorrect">⚠</span>' : ''}
        ${hasNote ? '<span class="badge badge-note" title="Has a note">📝</span>' : ''}
        <span class="list-filename">${escapeHtml(photo.filename)}</span>
      </div>
      <div class="list-row-date">${photo.date ? formatDateShort(photo.date) : '—'}</div>
    `;

    row.addEventListener('click', () => {
      // Pan to the marker and open the info panel.
      state.map.panTo({ lat: photo.lat, lng: photo.lng });
      state.map.setZoom(Math.max(state.map.getZoom(), 14));
      openInfoPanel(photo);

      // Highlight this row.
      document.querySelectorAll('.list-row.active').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    });

    el.photoListItems.appendChild(row);
  }

  if (!el.photoListItems.children.length) {
    el.photoListItems.innerHTML = '<p class="list-empty">No photos match your search.</p>';
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
      placePhotoMarkers(result.photos);
      renderPhotoList();
      setStatus(`${result.totalScanned} photos · ${result.totalWithGps} with GPS`);
    }
  } else if (type === 'remove') {
    const idx = state.markers.findIndex(m => m.data.filePath === filePath);
    if (idx !== -1) {
      state.markers[idx].marker.map = null;
      state.markers.splice(idx, 1);
      state.photos = state.photos.filter(p => p.filePath !== filePath);
      renderPhotoList();
      if (state.activePhoto?.filePath === filePath) closeInfoPanel();
      setStatus(`${state.photos.length} photos with GPS`);
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

  const ext          = getExtension(photoData.filename);
  const nameWithout  = photoData.filename.slice(0, -ext.length);

  el.renameInput.value    = nameWithout;
  el.renameExt.textContent = ext;
  el.photoDate.textContent = photoData.date ? formatDate(photoData.date) : 'Not available';
  el.photoCoords.textContent = `${photoData.lat.toFixed(6)}, ${photoData.lng.toFixed(6)}`;

  // Load saved note and flags.
  el.photoNotes.value        = pm.note    || '';
  el.badGpsCheckbox.checked  = pm.badGps  === true;
  el.photoPinColor.value     = pm.pinColor || resolveColor(photoData.filePath);

  hideRenameMessages();
  el.noteSavedMsg.classList.add('hidden');

  // Clear both undo states when switching to a new photo — undo only makes
  // sense for the photo currently displayed, not a previously opened one.
  state.lastRename = null;
  el.undoRenameBtn.classList.add('hidden');
  state.lastNote = null;
  el.undoNoteBtn.classList.add('hidden');

  el.infoPanel.classList.remove('hidden');
  el.zoomBtn.classList.add('hidden');

  // Load thumbnail asynchronously.
  el.photoThumbnail.style.display = 'none';
  el.thumbnailLoading.style.display = 'flex';

  const thumbPath = await window.photoMap.getThumbnail(photoData.filePath);
  if (thumbPath) {
    const url = window.photoMap.filePathToUrl(thumbPath);
    el.photoThumbnail.src = url;
    el.photoThumbnail.style.display = 'block';
    el.zoomBtn.classList.remove('hidden');
    // Store thumbnail URL for the lightbox.
    el.photoThumbnail.dataset.url = url;
  }
  el.thumbnailLoading.style.display = 'none';
}

function closeInfoPanel() {
  if (state.activePhoto) setMarkerHighlight(state.activePhoto.filePath, false);
  el.infoPanel.classList.add('hidden');
  state.activePhoto = null;
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

  const oldPath = state.activePhoto.filePath;

  // Capture a snapshot BEFORE updating state so undo can reverse everything.
  state.lastRename = {
    oldPath,
    oldName:      state.activePhoto.filename,
    newPath:      result.newPath,
    newName,
    // Deep copy the current metadata entry so undo can restore it exactly.
    metaSnapshot: state.meta.photos[oldPath]
      ? JSON.parse(JSON.stringify(state.meta.photos[oldPath]))
      : null
  };
  el.undoRenameBtn.classList.remove('hidden');

  state.activePhoto.filePath = result.newPath;
  state.activePhoto.filename = newName;

  // Rekey the in-memory metadata so it matches the new file path.
  // Without this, any subsequent saveMetadata() call would write a blank
  // record under the new path and effectively erase the notes/flags/color
  // that the main process already moved in photo-map-data.json.
  if (state.meta.photos[oldPath] !== undefined) {
    state.meta.photos[result.newPath] = state.meta.photos[oldPath];
    delete state.meta.photos[oldPath];
  }

  const markerEntry = state.markers.find(m => m.data.filePath === oldPath);
  if (markerEntry) {
    markerEntry.data.filePath = result.newPath;
    markerEntry.data.filename = newName;
    markerEntry.marker.title  = newName;
  }

  const photoEntry = state.photos.find(p => p.filePath === oldPath);
  if (photoEntry) { photoEntry.filePath = result.newPath; photoEntry.filename = newName; }

  renderPhotoList();
  showRenameSuccess();
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
    if (markerEntry.marker.title !== undefined) markerEntry.marker.title = u.oldName;
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
  const url = el.photoThumbnail.dataset.url;
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
  const fontSize = { small: '12px', medium: '16px', large: '22px' }[labelData.size] || '16px';
  const labelEl  = document.createElement('div');
  labelEl.className   = 'map-label';
  labelEl.style.fontSize = fontSize;
  labelEl.textContent = labelData.text;

  const marker = new google.maps.marker.AdvancedMarkerElement({
    map:      state.labelsVisible ? state.map : null,
    position: { lat: labelData.lat, lng: labelData.lng },
    content:  labelEl
  });

  marker.addListener('click', () => openEditLabelPopup(labelData));
  state.labelMarkers.push({ marker, labelData });
}

function toggleLabelPlacementMode() {
  state.placingLabel = !state.placingLabel;
  el.addLabelBtn.classList.toggle('active', state.placingLabel);
  document.getElementById('map').style.cursor = state.placingLabel ? 'crosshair' : '';
  el.addLabelBtn.textContent = state.placingLabel ? '✕ Cancel' : '+ Label';
  if (state.placingLabel) closeLabelPopup();
}

function showLabelPopupAtLatLng(latLng) {
  state.placingLabel = false;
  el.addLabelBtn.textContent = '+ Label';
  el.addLabelBtn.classList.remove('active');
  document.getElementById('map').style.cursor = '';

  state.pendingLabelLatLng = latLng;
  state.editingLabelId = null;

  el.labelTextInput.value  = '';
  el.labelSizeSelect.value = 'medium';
  el.labelPopupTitle.textContent = 'New Label';
  el.saveLabelBtn.textContent    = 'Place Label';
  el.deleteLabelBtn.classList.add('hidden');

  // Position popup near click point.
  const projection = state.map.getProjection();
  if (projection) {
    const point  = projection.fromLatLngToPoint(latLng);
    const scale  = Math.pow(2, state.map.getZoom());
    const mapDiv = document.getElementById('map');
    const bounds = mapDiv.getBoundingClientRect();
    const center = projection.fromLatLngToPoint(state.map.getCenter());
    const x = (point.x - center.x) * scale + bounds.width  / 2;
    const y = (point.y - center.y) * scale + bounds.height / 2;
    el.labelPopup.style.left = Math.min(x, bounds.width  - 220) + 'px';
    el.labelPopup.style.top  = Math.max(10, y - 160) + 'px';
  }

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
        me.marker.content.textContent = text;
        me.marker.content.style.fontSize = { small:'12px', medium:'16px', large:'22px' }[size] || '16px';
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
  if (mi !== -1) { state.labelMarkers[mi].marker.map = null; state.labelMarkers.splice(mi, 1); }
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
  for (const { marker } of state.labelMarkers)
    marker.map = visible ? state.map : null;
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
 * Called once during init() before Google Maps loads.
 */
function bindAppEvents() {

  // Toolbar
  el.toggleListBtn.addEventListener('click', () => {
    el.photoListPanel.classList.toggle('hidden');
    el.toggleListBtn.classList.toggle('active', !el.photoListPanel.classList.contains('hidden'));
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
  el.badGpsCheckbox.addEventListener('change', handleBadGpsToggle);
  el.photoPinColor.addEventListener('change', handlePhotoPinColorChange);
  el.resetPinColorBtn.addEventListener('click', handleResetPinColor);

  // Zoom button
  el.zoomBtn.addEventListener('click', openLightbox);
  el.photoThumbnail.addEventListener('dblclick', openLightbox);

  // Lightbox
  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => { if (e.target === el.lightbox) closeLightbox(); });
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
      loadGoogleMaps(state.apiKey);
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
  miniMap:       null,   // google.maps.Map instance for the left panel
  miniMarker:    null,   // AdvancedMarkerElement for the current photo's pin
  miniMapLabels: [],     // AdvancedMarkerElements mirroring the main map's labels.
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

  // Initialise the mini map once (Google Maps must already be loaded).
  if (!qr.miniMap && window.google?.maps) {
    qr.miniMap = new google.maps.Map(qrEl.mapDiv, {
      zoom: 20,
      center: { lat: 20, lng: 0 },
      mapTypeId: 'satellite',
      disableDefaultUI: true,
      gestureHandling: 'cooperative',
      mapId: 'qr-mini-map'
    });
  }

  // Rebuild the label markers on the mini map every time Quick Rename opens.
  // We do this unconditionally (not just on first init) so that any labels
  // added or deleted since the last session are always reflected correctly.
  if (qr.miniMap) {
    // Remove any previously placed label markers.
    for (const m of qr.miniMapLabels) m.map = null;
    qr.miniMapLabels = [];

    // Place a fresh copy of each label from the current session.
    for (const { labelData } of state.labelMarkers) {
      const fontSize = { small: '12px', medium: '16px', large: '22px' }[labelData.size] || '16px';
      const labelEl  = document.createElement('div');
      labelEl.className      = 'map-label';
      labelEl.style.fontSize = fontSize;
      labelEl.textContent    = labelData.text;
      const m = new google.maps.marker.AdvancedMarkerElement({
        map:      qr.miniMap,
        position: { lat: labelData.lat, lng: labelData.lng },
        content:  labelEl
      });
      qr.miniMapLabels.push(m);
    }
  }

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

  // Coordinates
  qrEl.coords.textContent = `${photo.lat.toFixed(5)}, ${photo.lng.toFixed(5)}`;

  // Mini map — jump directly to this photo's location at full zoom.
  // We use setZoom + setCenter rather than panTo because panTo animates
  // from the previous position and can leave the map at the wrong zoom level
  // if the map isn't fully settled yet.
  if (qr.miniMap) {
    const pos = { lat: photo.lat, lng: photo.lng };
    qr.miniMap.setZoom(20);
    qr.miniMap.setCenter(pos);

    if (qr.miniMarker) {
      qr.miniMarker.position = pos;
    } else {
      const pin = new google.maps.marker.PinElement({
        background: resolveColor(photo.filePath),
        borderColor: '#ffffff', glyphColor: '#ffffff', glyph: '📷'
      });
      qr.miniMarker = new google.maps.marker.AdvancedMarkerElement({
        map: qr.miniMap, position: pos, content: pin.element
      });
    }
  }

  // Thumbnail
  qrEl.img.style.opacity     = '0';
  qrEl.zoomBtn.classList.add('hidden');
  qrEl.loading.style.display = 'flex';
  qrEl.loading.textContent   = 'Loading…';

  const thumbPath = await window.photoMap.getThumbnail(photo.filePath);
  if (thumbPath) {
    const url = window.photoMap.filePathToUrl(thumbPath);
    qrEl.img.onload = () => {
      qrEl.img.style.opacity     = '1';
      qrEl.loading.style.display = 'none';
      qrEl.zoomBtn.classList.remove('hidden');
      qrEl.img.dataset.url = url;
      qr.loading = false;
    };
    qrEl.img.src = url;
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

  // Keep all state in sync after rename.
  if (state.meta.photos[photo.filePath] !== undefined) {
    state.meta.photos[result.newPath] = state.meta.photos[photo.filePath];
    delete state.meta.photos[photo.filePath];
  }

  const sp = state.photos.find(p => p.filePath === photo.filePath);
  if (sp) { sp.filePath = result.newPath; sp.filename = newName; }

  const me = state.markers.find(m => m.data.filePath === photo.filePath);
  if (me) {
    me.data.filePath = result.newPath; me.data.filename = newName;
    if (me.marker.title !== undefined) me.marker.title = newName;
  }

  photo.filePath = result.newPath;
  photo.filename = newName;

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
  const url = qrEl.img.dataset.url;
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
  if (!state.photos.length) {
    showSettingsMessage('No photos with GPS to export.', 'error');
    return;
  }

  let result;
  try {
    result = await window.photoMap.exportData({
      photos:   state.photos,
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
 * Handles: headings (# ## ###), bold (**), code blocks (```), inline code (`),
 * horizontal rules (---), unordered lists (- item), and paragraphs.
 * All HTML characters in the source text are escaped before conversion so
 * the README content cannot inject scripts or break the layout.
 *
 * Input:  md — a Markdown string
 * Returns: an HTML string safe to set as innerHTML
 */
function markdownToHtml(md) {
  const lines = md.split('\n');
  const out   = [];
  let inCodeBlock  = false;
  let inList       = false;
  let codeLang     = '';
  let codeLines    = [];

  /*
   * Flushes a collected list and resets the list state.
   */
  function flushList() {
    if (inList) { out.push('</ul>'); inList = false; }
  }

  /*
   * Applies inline Markdown formatting (bold, inline code) to a line of text
   * that has already been HTML-escaped.  Order matters: code spans are applied
   * first so that bold markers inside them are not processed.
   */
  function inlineFormat(text) {
    // Inline code: `text` → <code>text</code>
    text = text.replace(/`([^`]+)`/g, (_, code) =>
      `<code class="md-inline-code">${code}</code>`
    );
    // Bold: **text** → <strong>text</strong>
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return text;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trimEnd();

    // ── Fenced code block (``` lang) ───────────────────────────────────────
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        flushList();
        inCodeBlock = true;
        codeLang    = line.slice(3).trim();
        codeLines   = [];
      } else {
        // Closing fence — emit the block.
        const escaped = codeLines.map(l => escapeHtml(l)).join('\n');
        const langAttr = codeLang ? ` class="md-code-lang-${escapeHtml(codeLang)}"` : '';
        out.push(`<pre class="md-code-block"><code${langAttr}>${escaped}</code></pre>`);
        inCodeBlock = false;
        codeLines   = [];
        codeLang    = '';
      }
      continue;
    }

    if (inCodeBlock) { codeLines.push(raw); continue; }

    // ── Blank line ─────────────────────────────────────────────────────────
    if (!line.trim()) {
      flushList();
      continue;
    }

    // ── Headings ───────────────────────────────────────────────────────────
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h1) { flushList(); out.push(`<h1 class="md-h1">${inlineFormat(escapeHtml(h1[1]))}</h1>`); continue; }
    if (h2) { flushList(); out.push(`<h2 class="md-h2">${inlineFormat(escapeHtml(h2[1]))}</h2>`); continue; }
    if (h3) { flushList(); out.push(`<h3 class="md-h3">${inlineFormat(escapeHtml(h3[1]))}</h3>`); continue; }

    // ── Horizontal rule ────────────────────────────────────────────────────
    if (/^---+$/.test(line.trim())) { flushList(); out.push('<hr class="md-hr"/>'); continue; }

    // ── Unordered list item ────────────────────────────────────────────────
    const li = line.match(/^[-*] (.+)/);
    if (li) {
      if (!inList) { out.push('<ul class="md-ul">'); inList = true; }
      out.push(`<li class="md-li">${inlineFormat(escapeHtml(li[1]))}</li>`);
      continue;
    }

    // ── Paragraph ──────────────────────────────────────────────────────────
    flushList();
    out.push(`<p class="md-p">${inlineFormat(escapeHtml(line))}</p>`);
  }

  flushList();
  if (inCodeBlock && codeLines.length) {
    // Unclosed code block — emit what we have.
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
function showLockError(lockResult, folderPath) {
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
  } catch { return isoString; }
}

// Safely converts a string so it can be placed in innerHTML without XSS.
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

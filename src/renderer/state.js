// ─── Shared State & DOM References ────────────────────────────────────────────
//
// All mutable application state lives in `state`. All DOM element references
// live in `el`. Both are exported as plain objects so every module that imports
// them reads and mutates the same instance — no copying.
//
// Quick-Rename mode has its own runtime state (`qr`) and DOM refs (`qrEl`).
// They live here alongside `state`/`el` so renderer.js can access `qrEl.overlay`
// in the global Escape-key handler without importing quickRename.js.

import { DEFAULT_PIN_COLOR } from '../utils.js';

// Kept in sync with CURRENT_VERSION in src/main/metadata-io.js.
// The renderer cannot import from the main process, so this is the renderer-side copy.
export const CURRENT_METADATA_VERSION = 2;

export const state = {
  apiKey:       '',
  folderPath:   '',
  recursive:    true,
  pinColor:     DEFAULT_PIN_COLOR,

  meta: {
    version:  CURRENT_METADATA_VERSION,
    pinColor: DEFAULT_PIN_COLOR,
    labels:   [],
    photos:   {}
  },

  photos:   [],

  map:          null,
  satelliteLayer: null,
  streetsLayer:   null,
  markers:      [],
  labelMarkers: [],
  labelsVisible: true,

  activePhoto:     null,
  placingLabel:    false,
  pickingCoords:   false,
  lastGpsEdit:     null,
  editingLabelId:  null,
  pendingLabelLatLng: null,

  lightboxScale:   1,
  lightboxOrigin:  { x: 0, y: 0 },

  sidebarWidth:    340,
  isResizing:      false,

  lastRename:       null,
  listFilter:       'all',
  lastNote:         null,
  pregenThumbnails: false
};

export const el = {
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
  clearCacheBtn:         document.getElementById('clear-cache-btn'),
  pregenChk:             document.getElementById('pregen-thumbnails-chk'),
  settingsMessage:       document.getElementById('settings-message'),
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

  // Map and body
  mapDiv:     document.getElementById('map'),
  appBody:    document.getElementById('app-body'),

  // Pregen progress overlay
  pregenOverlay:      document.getElementById('pregen-overlay'),
  pregenProgressBar:  document.getElementById('pregen-progress-bar'),
  pregenProgressText: document.getElementById('pregen-progress-text'),
  pregenCancelBtn:    document.getElementById('pregen-cancel-btn')
};

// Quick-Rename runtime state — index, loading guard, mini-map references, undo snapshot.
export const qr = {
  photos:        [],
  index:         0,
  loading:       false,
  miniMap:       null,
  miniMarker:    null,
  miniMapLabels: [],
  lastState:     null,
  lastNoteState: null
};

export const qrEl = {
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

// ─── Shared Constants ──────────────────────────────────────────────────────────

export const LABEL_FONT_SIZES = { small: '12px', medium: '16px', large: '22px' };

export const MAPTILER_ATTRIBUTION =
  '© <a href="https://www.maptiler.com/copyright/" target="_blank">MapTiler</a> ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a> ' +
  '| <a href="https://leafletjs.com" target="_blank">Leaflet</a>';

// ─── Status bar helper ─────────────────────────────────────────────────────────

export function setStatus(msg) { el.statusText.textContent = msg; }

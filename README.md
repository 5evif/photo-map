# 📍 Photo Map

Photo Map is a desktop application that scans a folder of photos, reads the GPS coordinates embedded in each photo's EXIF metadata, and displays them as clickable markers on an interactive Google Maps satellite view.

Click any marker to see a thumbnail of the photo, rename it, write a note, flag its GPS data as incorrect, or change its pin color. Use **Quick Rename** mode to cycle through every photo in a single keyboard-driven workflow. All your annotations — notes, flags, pin colors, and map labels — are saved to a sidecar file (`photo-map-data.json`) stored inside your photo folder, so the data travels with the photos if you move or share them.

---

## Prerequisites

**To run from source:**
- Node.js 18 or higher — download from https://nodejs.org

**To build a distributable installer:**
- Windows: Visual Studio C++ Build Tools (see Build section)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux: `build-essential` (`sudo apt install build-essential`)

**A Google Maps API key** with the **Maps JavaScript API** enabled:
1. Go to https://console.cloud.google.com
2. Create or select a project
3. Go to **APIs & Services → Library** and enable **Maps JavaScript API**
4. Go to **APIs & Services → Credentials** and create an **API Key**
5. Copy the key — you will paste it into the app on first launch

---

## Install & Run (from source)

```bash
# 1. Unzip the project and open a terminal in the photo-map folder

# 2. Install dependencies
npm install

# 3. Start the app
npm start
```

On first launch the app will ask for your Google Maps API key and your photo folder. These are saved automatically for future launches.

---

## Build a Distributable Installer

The installer bundles everything — Chromium, Node.js, all dependencies — so recipients need nothing pre-installed.

### Windows

```powershell
# One-time setup: install C++ Build Tools (needed to compile sharp)
npm install --global windows-build-tools

# Build the installer
npm run build:win
```

Output: `dist/Photo Map Setup.exe`

### macOS

```bash
# Generate the .icns app icon (required — only works on macOS)
iconutil -c icns assets/icons/icon.iconset -o assets/icons/icon.icns

# Build the DMG
npm run build:mac
```

Output: `dist/Photo Map.dmg` (contains both Intel x64 and Apple Silicon arm64 builds)

### Linux

```bash
npm run build:linux
```

Output: `dist/Photo Map.AppImage` and `dist/Photo Map.deb`

> **Note:** Each build command runs `electron-rebuild` first to recompile `sharp`'s native bindings for Electron's bundled Node.js runtime. This is automatic — you don't need to do anything extra.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Electron App                                   │
│                                                                             │
│  ┌──────────────────────────┐  IPC messages  ┌─────────────────────────┐   │
│  │      Main Process        │ ◄────────────► │    Renderer Process     │   │
│  │      (main.js)           │                │    (index.html +        │   │
│  │                          │  preload.js    │     renderer.js)        │   │
│  │  • Reads/writes files    │  creates a     │                         │   │
│  │  • Scans EXIF data       │  safe bridge   │  • Google Maps UI       │   │
│  │  • Makes thumbnails      │  called        │  • Photo pin markers    │   │
│  │    (worker thread)       │  window        │  • Info panel + undo    │   │
│  │  • Renames files         │  .photoMap     │  • Quick Rename mode    │   │
│  │  • Manages lock file     │                │  • Settings + export    │   │
│  │  • Watches folder        │                │  • Lock error screen    │   │
│  │  • Exports GeoJSON/CSV   │                │                         │   │
│  └──────────────────────────┘                └─────────────────────────┘   │
│                                                                             │
│  electron-store: saves API key, folder path, sidebar width, pin color      │
│  photo-map-data.json: lives in your photo folder, stores all annotations   │
│    (notes, bad-GPS flags, pin colors, map labels)                          │
│  photo-map-data.lock: created when a folder is opened, deleted on close    │
│    — prevents two users editing annotations at the same time               │
└─────────────────────────────────────────────────────────────────────────────┘

External services:
  Google Maps JavaScript API — loaded in the renderer via <script> tag
```

**Startup sequence:**
1. `main.js` creates the window and loads `index.html`
2. `preload.js` injects `window.photoMap` into the page
3. `renderer.js` loads saved settings and shows the setup screen (pre-populated with last-used values)
4. User clicks **Open Map →** — the app acquires the folder lock
5. Google Maps loads and the folder is scanned (live progress shown in the status bar)
6. HEIC thumbnail generation runs in a background worker thread so the UI stays responsive
7. A marker is placed on the map for each photo that has GPS coordinates
8. `chokidar` starts watching the folder for new or deleted photos

---

## Features

### Map View
- Satellite map by default; toggle to roadmap using the control in the top-right corner
- Click any photo pin to open the info panel
- Zoom and pan normally; all markers fit on screen on first load
- Status bar shows live scan progress while a large folder is being read

### Info Panel (right sidebar)
- Thumbnail preview — click ⤢ or double-click to open the full-screen zoom viewer
- Rename the file directly from the panel; the GPS cache and annotation data follow the rename automatically
- **↩ Undo Rename** button (or Cmd/Ctrl+Z) — reverses the last rename and restores the previous note, flag, and pin color in one step
- Add a note — saved automatically when you switch to another photo
- Mark GPS as incorrect — removes the pin from the map; photo stays in the list with a ⚠ badge
- Set a per-photo pin color, or reset to the global default
- Show in Folder button

### Photo List (left sidebar)
- Toggle with the ☰ Photos button in the toolbar
- Sorted alphabetically; search by filename
- Filter buttons: **All**, **⚠ Bad GPS**, **📝 Has Note** — search and filter work together
- ⚠ badge = bad GPS flag; 📝 badge = has a note
- Click any row to pan the map to that marker and open the info panel

### Quick Rename
- Opens a full-screen two-column layout: satellite mini-map + notes/GPS flag on the left; large photo + rename bar on the right
- **Enter** — save the new name (if changed) and move to the next photo; note is auto-saved
- **Tab** — toggle the bad-GPS flag for the current photo
- **Skip →** button — advance without renaming
- **⤢** or double-click — open the zoom lightbox on top of Quick Rename
- **Esc** — exit Quick Rename
- Cycles through all photos alphabetically

### Map Labels
- Click **+ Label** in the toolbar, then click anywhere on the map to place a text label
- Click an existing label to edit its text or delete it
- Label visibility can be toggled in the Settings panel

### Export
- **Export GeoJSON** — exports all GPS photos and their annotations as a GeoJSON FeatureCollection, compatible with QGIS, ArcGIS, Mapbox, and most other GIS tools
- **Export CSV** — exports one row per photo with filename, coordinates, date, note, and bad-GPS flag; opens directly in Excel or Google Sheets
- Both buttons are in the Settings panel

### Annotations File
All annotations are saved to `photo-map-data.json` inside your photo folder. This includes notes, bad-GPS flags, per-photo pin colors, and map labels. The file is human-readable JSON and travels with the photos if you move or share the folder.

### Concurrent Access Lock
When Photo Map opens a folder it creates `photo-map-data.lock` inside that folder. If a second user tries to open the same folder at the same time, they see a clear error showing who has it open and on which machine. The lock is automatically released when the app closes. If the app crashes and leaves a stale lock file, users can delete `photo-map-data.lock` manually to recover.

### Offline Detection
If your network connection drops while the app is open, a warning appears in the status bar. The map tiles and any ongoing API calls may stop working, but your local annotations are unaffected. The status bar updates again when the connection is restored.

---

## Troubleshooting

### "Google Maps API key error" banner appears
Your API key is invalid, or the Maps JavaScript API is not enabled for it.
- Open Settings (⌘, on Mac, or the ⚙ Settings button)
- Check the API key
- In Google Cloud Console, confirm "Maps JavaScript API" is enabled
- Make sure the key has no API restrictions blocking your machine

### HEIC photos have no thumbnail
The app tries three methods to generate HEIC thumbnails:
1. Embedded JPEG preview (fastest — common on iPhones)
2. `heic-convert` (pure JS decoder — works even if the preview was stripped)
3. `sharp` direct decode (fallback — requires the libheif plugin)

If thumbnails still fail, open the Developer Tools console (View → Toggle Developer Tools) and look for the error message. It will identify which step failed and why.

### Photos don't appear on the map
Photos only appear if they have GPS coordinates embedded in their EXIF data. Common reasons they don't:
- Location was turned off on the camera/phone when the photo was taken
- An editing tool stripped the EXIF data
- "Scan subfolders" is disabled in Settings but the photos are in a subfolder
- Click **↻ Refresh** in the toolbar to force a re-scan

### "Folder In Use" error when opening
Another instance of Photo Map has this folder open. The error shows the username, machine name, and time the folder was opened. Close the app on that machine, then click Retry. If the app crashed and left a stale lock, delete `photo-map-data.lock` from the photo folder manually.

### "Folder is Read-Only" error
The photo folder is on a read-only drive or a network share where you don't have write permission. Annotations cannot be saved. Either copy the photos to a writable location, or contact your IT administrator to grant write access to that share.

### Notes or annotations disappear after renaming
This was a bug in early development that has been fixed since build 1.0.0. After a rename, the annotation data is rekeyed in memory immediately and written to disk before anything else can overwrite it, so notes, flags, and pin colors remain linked to the file under its new name.

### App won't launch
- Confirm Node.js 18+ is installed: `node --version`
- Delete `node_modules` and run `npm install` again
- On macOS, if the built app won't open, right-click it and choose "Open" to bypass Gatekeeper
- Check the developer console (View → Toggle Developer Tools) for JavaScript errors

---

## How to Modify

### Add a new supported photo file type
1. Open `src/main/main.js`
2. Find the `SUPPORTED_EXTENSIONS` Set (search for `.jpg`)
3. Add the new extension, e.g. `'.tiff'`

### Change the photo pin emoji or color
1. Open `src/renderer/renderer.js`
2. Find the `createPhotoMarker` function
3. Change `glyph`, `background`, `borderColor`, or `glyphColor` inside the `PinElement` options

### Change the map label appearance
1. Open `src/renderer/styles.css`
2. Find the `.map-label` CSS class
3. Change `background`, `color`, `border`, or `font-size`

### Change where app settings are stored
Settings are stored by `electron-store` in the OS app-data folder:
- **macOS:** `~/Library/Application Support/photo-map/`
- **Windows:** `%APPDATA%\photo-map\`
- **Linux:** `~/.config/photo-map/`

### Add a new per-photo annotation field
1. Add the field to the default object in `getPhotoMeta()` in `renderer.js`
2. Add a UI control in the info panel section of `index.html`
3. Wire up the save/load logic in `renderer.js` following the pattern used by `note` or `badGps`
4. The new field will automatically be included in `photo-map-data.json`

---

## Custom App Icons

Placeholder icons are provided in `assets/icons/`. To replace them:

- **macOS:** Replace `assets/icons/icon.icns`. To create one from a 1024×1024 PNG:
  ```bash
  cp your-icon-1024.png assets/icons/icon.iconset/icon_512x512@2x.png
  # (populate the other sizes too, then:)
  iconutil -c icns assets/icons/icon.iconset -o assets/icons/icon.icns
  ```
- **Windows:** Replace `assets/icons/icon.ico` with a multi-size ICO file. Tools like https://icoconvert.com can create one from a PNG.
- **Linux:** Replace `assets/icons/icon_linux.png` with a 512×512 PNG.

Rebuild after replacing icons: `npm run build`.

---

## About

Build 1.0.0 · 2026-05-09
Built by Alex Tyler & Claude

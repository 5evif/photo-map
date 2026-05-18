# 📍 Photo Map

Photo Map is a desktop app that reads the GPS location stored inside your photo files and shows each one as a pin on an interactive satellite map. Click any pin to see a thumbnail, rename the file, write a note, or correct the location. All your work is saved automatically alongside your photos — nothing is ever uploaded anywhere.

---

## Getting Started

On first launch, Photo Map asks for two things:

**MapTiler API Key**
Photo Map uses MapTiler to display satellite and street map tiles. A free account at [maptiler.com](https://cloud.maptiler.com/account/keys/) includes enough monthly tile requests for personal use. Click **Get one here →** to open the MapTiler website in your browser; once you have a key, come back to the app and paste it in. The key is saved so you only need to enter it once.

**Photo Folder**
Click **Browse…** to choose the folder that contains your photos. The app will scan it immediately and place a pin on the map for every photo that has GPS data embedded in it. If your photos are organised into subfolders, tick **Scan subfolders** in Settings after the initial setup.

Click **Open Map →** when both fields are filled in.

---

## The Map

The map is the main view. Each pin represents one photo. The map starts zoomed to fit all your pins on screen.

- **Zoom and pan** with your mouse or trackpad in the usual way.
- **Click a pin** to open the Photo Details panel on the right side of the screen.
- **Layer toggle** (top-right corner of the map) — switch between Satellite view and OpenStreetMap view.
- **Status bar** (bottom of the screen) — shows how many photos were found and how many have GPS data. During a scan it shows live progress. If your internet connection drops, an offline warning appears here — your annotations are unaffected, but map tiles will stop loading until connectivity is restored.
- **↻ Refresh** (toolbar) — re-scans the photo folder and fits the map view to show all pins and labels. Use this after adding or deleting photos outside the app.
- **Address Search** (top-left corner of the map, below the zoom buttons) — type a place name or address and press **Enter** (or click **⌕**). Up to five matching results appear in a dropdown; click one to fly the map to that location. A small orange marker shows the searched spot and stays on the map until you perform a new search.

---

## Photo Details Panel

Click any pin on the map, or any row in the Photo List, to open the details panel on the right. You can resize the panel by dragging its left edge — the width is remembered between sessions.

Use the **←** and **→** buttons at the top of the panel (or the left and right arrow keys) to step through the photos in the current filtered list without going back to the map. The buttons are disabled when you are at the first or last photo in the list.

### Thumbnail
A preview of the photo is shown at the top of the panel. Click the **⤢** button or double-click the image to open it full-screen at its original resolution. Click anywhere outside the image, or press **Esc**, to close the full-screen view.

### Renaming
The filename is shown in an editable field. Change the name and press **Enter** or click **Rename**. The extension (`.jpg`, `.heic`, etc.) is preserved automatically. If a file with that name already exists, the app adds a copy number — for example, `photo (2).jpg` — so no files are ever overwritten.

After renaming, an **↩ Undo Rename** button appears. Clicking it (or pressing **Cmd+Z** on Mac / **Ctrl+Z** on Windows) reverts the filename on disk and restores the previous notes, GPS flag, and pin color in one step.

### Date Taken
Shows the date and time the photo was taken, read from the photo's EXIF metadata. If no date is recorded, this shows "Not available."

### Coordinates
Shows the GPS latitude and longitude recorded in the photo, or "None" if no GPS data is present.

**✎ Set** — opens a coordinate editor. You can:
- Type a latitude and longitude directly into the fields (decimal degrees, e.g. 51.507351, −0.127758).
- Click anywhere on the map while the editor is open to fill in the coordinates of that point. The map cursor changes to a crosshair to indicate pick mode.
- Press **Enter** in either field, or click **Save**, to apply the new coordinates. A pin will appear (or move) on the map immediately.

After saving, an **↩ Undo GPS Edit** button appears, which reverts the coordinates to what they were before.

**✕ Clear** — visible only when coordinates have been set manually. Clears the manual override and reverts to the original GPS data from the photo file, or back to "None" if there was none.

> **Note:** Setting or clearing coordinates never modifies the photo file itself. The manual location is stored in the sidecar file alongside your photos. See *Your Photos Are Safe* below.

### Notes
A free-text notes field for anything you want to remember about the photo. Notes save automatically when you click on a different photo. You can also click **Save Note** explicitly. After saving, an **↩ Undo** button appears to restore the previous note.

### Mark GPS as Incorrect
Tick **⚠ Mark GPS data as incorrect** to flag a photo whose GPS coordinates are wrong or unreliable. This removes the pin from the map but keeps the photo in the Photo List with a ⚠ badge. Untick it to restore the pin.

### Pin Colour
Choose a colour for this photo's pin. This overrides the global pin colour set in Settings. Click **Use Global** to remove the per-photo colour and go back to the default.

### Show in Folder
Opens the folder containing the photo in Windows Explorer (or Finder on Mac), with the file highlighted.

---

## Photo List

Click **☰ Photos** in the toolbar to open the photo list on the left side of the screen. All photos appear here — including ones with no GPS data, which are shown with a ⚠ badge.

### Searching and Filtering
- **Search box** — type part of a filename to narrow the list.
- **All** — shows every photo.
- **⚠ Bad GPS** — shows only photos flagged as having incorrect or missing GPS data.
- **📝 Has Note** — shows only photos that have a note.
- **✎ GPS Set** — shows only photos whose coordinates have been set manually using the **✎ Set** button.

Search and filter work together. When a filter is active, **only the matching photos are shown as pins on the map** — the rest of the pins are hidden until you clear the filter.

### Badges
- ⚠ — the GPS data has been flagged as incorrect (or the photo has no GPS data at all).
- 📝 — the photo has a note.
- ✎ — the photo's location was set manually (overrides the built-in GPS data).

### Clicking a Row
Clicking a photo in the list pans the map to that photo's pin (if it has one) and opens the Photo Details panel.

---

## Quick Rename

**Quick Rename** is a full-screen mode for efficiently working through a large set of photos in one session. Click **✏ Quick Rename** in the toolbar to open it.

The screen is split into two columns:
- **Left column** — a small satellite map showing the current photo's location, its coordinates, a notes field, and a bad-GPS toggle.
- **Right column** — a large version of the photo and a rename bar at the bottom.

### Controls

| Action | How |
|--------|-----|
| Save new name and move to next photo | **Enter**, or click **Save & Next ↵** |
| Move to next photo without renaming | Click **Skip →** |
| Toggle bad-GPS flag | **Tab** |
| Undo the last rename and go back to that photo | Click **↩ Undo** |
| View photo full-screen | Click **⤢** or double-click the photo |
| Exit Quick Rename | **Esc** or click **✕** |

If the name you type already exists, the app appends a copy number automatically (same as in the details panel).

Notes are auto-saved when you advance to the next photo.

---

## Map Labels

Text labels can be placed anywhere on the map — useful for marking regions, trip names, or points of interest.

- Click **+ Label** in the toolbar. The button highlights and the map cursor changes.
- Click anywhere on the map to open the label editor. Type your text, choose a size (Small, Medium, Large), and click **Place Label**.
- **Click an existing label** to edit it or delete it.
- Labels can be hidden or shown from the **Settings** panel (Show map labels toggle).

Labels are saved in the sidecar file and reappear every time you open the folder.

---

## Settings

Click **⚙ Settings** in the toolbar to open the settings panel.

| Setting | What it does |
|---------|--------------|
| **MapTiler API Key** | Update your API key if it changes. Changes take effect after clicking **Save & Reload**. |
| **Photo Folder** | Click **Change…** to switch to a different folder. The app will re-scan and reload. |
| **Scan subfolders** | When ticked, the app looks for photos inside subfolders of the main folder. |
| **Show map labels** | Toggle the visibility of all text labels on the map. |
| **Default Pin Colour** | Sets the colour used for all pins that don't have an individual colour assigned. |
| **Export GeoJSON** | Saves all GPS photos and their annotations to a `.geojson` file you choose. Compatible with QGIS, ArcGIS, Mapbox, and most other mapping tools. |
| **Export CSV** | Saves a spreadsheet with one row per photo — filename, coordinates, date, note, and GPS flag. Opens directly in Excel or Google Sheets. |
| **Clear All Thumbnails** | Deletes the thumbnail cache to free up disk space. Thumbnails regenerate on demand the next time you view a photo. |

---

## Troubleshooting

### "MapTiler API key error" banner appears
The API key stored in Settings is invalid, has been disabled, or has a domain/IP restriction that blocks your machine.
- Open Settings (⚙ Settings button) and verify the key.
- Log in to your MapTiler account and confirm the key is active and has no restrictions.

### "MapTiler request limit reached" banner appears
Your MapTiler account has used its monthly tile request quota. The map will be blank until the quota resets (monthly).
- Log in to your MapTiler account to check your usage and reset date.
- Upgrading your MapTiler plan increases the quota.
- Your annotations, notes, and GPS data are all unaffected — the problem is only with displaying the map background.

### Photos don't appear on the map
Photos only show a pin if they have GPS coordinates embedded in their EXIF metadata.
- Location services may have been turned off on the camera or phone when the photo was taken.
- An editing application may have stripped EXIF data from the file.
- If the photo is in a subfolder, make sure **Scan subfolders** is ticked in Settings.
- Photos with no GPS data still appear in the Photo List with a ⚠ badge. You can assign coordinates to them manually using the **✎ Set** button.
- Click **↻ Refresh** in the toolbar to re-scan after making changes in Settings.

### HEIC photos have no thumbnail
The app tries three methods to generate HEIC previews, in order:
1. Extract the full-resolution JPEG preview embedded inside the HEIC file (fastest, common on iPhone photos).
2. Use a JavaScript HEIC decoder to convert the image directly.
3. Use the `sharp` library as a final fallback (may require additional system libraries on Linux).

If all three methods fail, the photo will display a loading indicator. Check the developer console (right-click anywhere in the app → Inspect → Console) for a specific error message.

### "Folder In Use" error when opening
Another instance of Photo Map already has this folder open. The error message shows the username, machine name, and time the folder was opened.
- Close the app on the other machine or in the other window.
- Click **Retry** once it has been closed.
- If the app crashed and left a stale lock, delete `photo-map-data.lock` from the photo folder manually, then click **Retry**.

### Photo folder was moved or renamed
If you move or rename your photo folder outside the app, the next launch will point to a path that no longer exists and no photos will appear.
- Open **⚙ Settings** and click **Change…** to select the new folder location.
- Your annotations are stored inside the folder itself (`photo-map-data.json`), so they travel with the photos and will reappear once you point the app at the new location.

### "Folder is Read-Only" error
The photo folder is on a read-only drive or a network share where you do not have write permission. Because annotations are saved into the folder, the app cannot function without write access.
- Copy the photos to a writable folder on your computer.
- If the folder is on a shared drive, ask your IT administrator for write access.

### App won't launch
- Confirm Node.js 18 or newer is installed: open a terminal and run `node --version`.
- Delete the `node_modules` folder and run `npm install` again.
- On macOS, if the built app won't open, right-click it and choose **Open** to bypass Gatekeeper the first time.

---

## Your Photos Are Safe

Photo Map is designed to be completely non-destructive. Here is exactly what the app does — and doesn't do — with your files.

### The app never modifies your original photo files
The only operation that changes a photo file is **Rename**, and that only happens when you explicitly type a new name and confirm it. Even then, only the filename changes — the contents of the file are untouched.

**EXIF data** (the embedded information about date, camera settings, and GPS location) is **read-only**. The app reads GPS coordinates and dates from EXIF when scanning, but never writes anything back into the image file.

### GPS overrides stay in the sidecar file
When you use the **✎ Set** button to assign or correct coordinates, the new location is saved in `photo-map-data.json` — a separate file alongside your photos — not written back into the image's EXIF. Your original EXIF GPS data is always preserved in the photo file and is always shown as the fallback if you click **✕ Clear** to remove a manual override.

### Thumbnails are stored outside your photo folder
When Photo Map generates a preview for a photo (particularly for HEIC or DNG files that the browser can't display natively), the preview is saved to a cache folder inside the app's own data area on your computer — **not** inside your photo folder. Clearing the thumbnail cache in Settings removes these files; your originals are unaffected.

### The only files added to your photo folder
Photo Map creates two files inside your photo folder:

- **`photo-map-data.json`** — stores your notes, GPS flags, pin colours, manual coordinate overrides, and map labels. It is plain human-readable text (JSON format) and travels with your photos if you copy or move the folder.
- **`photo-map-data.lock`** — a small lock file created when you open the folder and deleted automatically when the app closes. It prevents two people editing the same folder's annotations at the same time. If the app crashes, this file may be left behind in your photo folder; deleting it manually and clicking **Retry** is all that is needed. See *Folder In Use error when opening* in Troubleshooting for details.

### Your photos never leave your computer
Photo Map does not upload your photos, thumbnails, EXIF data, or annotations to any server. The only network traffic the app makes is requests to MapTiler's tile API to download map imagery (the same as any online map application) and a brief status check when a tile fails to load, to determine whether the issue is an invalid API key or a quota limit. No photo data is included in any of these requests.

---

## Technical Reference

This section is for developers and advanced users who want to understand how the app is built or modify it.

### Architecture

Photo Map is built with [Electron](https://www.electronjs.org/), which packages a Node.js backend and a Chromium browser frontend into a single desktop application.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              Electron App                                 │
│                                                                           │
│  ┌──────────────────────────┐  IPC messages  ┌─────────────────────────┐  │
│  │      Main Process        │ ◄────────────► │    Renderer Process     │  │
│  │      (main.js)           │                │    (index.html +        │  │
│  │                          │  preload.js    │     renderer modules)   │  │
│  │  • Reads/writes files    │  creates a     │                         │  │
│  │  • Scans EXIF data       │  safe bridge   │  • Leaflet/MapTiler map │  │
│  │  • Makes thumbnails      │  called        │  • Photo pin markers    │  │
│  │    (worker thread)       │  window        │  • Info panel + undo    │  │
│  │  • Renames files         │  .photoMap     │  • Quick Rename mode    │  │
│  │  • Manages lock file     │                │  • Settings + export    │  │
│  │  • Watches folder        │                │  • Label placement      │  │
│  │  • Exports GeoJSON/CSV   │                │                         │  │
│  └──────────────────────────┘                └─────────────────────────┘  │
│                                                                           │
│  electron-store — saves API key, folder path, sidebar width, pin color    │
│  photo-map-data.json — lives in photo folder, stores all annotations      │
│  photo-map-data.lock — cooperative lock, created on open, deleted on close│
└───────────────────────────────────────────────────────────────────────────┘
```

**Key libraries:**
- [Leaflet 1.9](https://leafletjs.com/) — open-source map rendering; runs entirely in the renderer
- [MapTiler](https://www.maptiler.com/) — provides satellite and OpenStreetMap tile layers via API
- [exifr](https://github.com/MikeKovarik/exifr) — reads GPS coordinates, dates, and embedded previews from EXIF
- [sharp](https://sharp.pixelplumbing.com/) — generates JPEG thumbnails from HEIC, DNG, and other formats
- [heic-convert](https://github.com/catdad-experiments/heic-convert) — pure-JavaScript HEIC decoder used as thumbnail fallback
- [chokidar](https://github.com/paulmillr/chokidar) — watches the photo folder for new or deleted files
- [electron-store](https://github.com/sindresorhus/electron-store) — persists app settings between sessions
- [marked](https://marked.js.org/) — renders the in-app README viewer

### Renderer Module Map

The renderer is split into focused ES modules. `renderer.js` is a thin orchestrator; all business logic lives in these modules:

| Module | Responsibility |
|--------|---------------|
| `renderer.js` | App init, screen switching, toolbar wiring, global keyboard shortcuts |
| `scanner.js` | Scan pipeline, folder watching, settings reload, lock-screen helpers |
| `state.js` | Shared mutable state, DOM refs, constants |
| `metadata.js` | Read / write `photo-map-data.json`; migration runner |
| `map.js` | Leaflet init, pin markers, address search |
| `photoList.js` | Left sidebar photo list, search, filter |
| `infoPanel.js` | Right info panel, GPS editor, rename, lightbox, sidebar resize |
| `labels.js` | Map text label placement, editing, persistence |
| `quickRename.js` | Full-screen rename mode |
| `settings.js` | Settings overlay, GeoJSON/CSV export, README viewer |

### Startup Sequence
1. `main.js` creates the browser window and loads `index.html`.
2. `preload.js` runs before the page loads and injects `window.photoMap` — a safe bridge for IPC calls.
3. `renderer.js` reads saved settings, then shows the setup screen pre-populated with the last-used folder and API key.
4. The user clicks **Open Map →**; the app writes the lock file and initialises the Leaflet map.
5. The folder is scanned; live progress appears in the status bar.
6. HEIC/DNG thumbnail generation runs in a background worker thread so the UI stays responsive.
7. Pins are placed on the map for every photo that has GPS data.
8. `scanner.js` starts `chokidar` watching the folder; adding or removing a photo file triggers a re-scan automatically.

### Files Created by the App

| File | Location | Purpose |
|------|----------|---------|
| `photo-map-data.json` | Inside your photo folder | All annotations: notes, GPS flags, pin colours, coordinate overrides, map labels |
| `photo-map-data.lock` | Inside your photo folder | Cooperative lock — prevents concurrent edits |
| `thumbnails/` cache | `%APPDATA%\photo-map\thumbnails` (Windows) / `~/Library/Application Support/photo-map/thumbnails` (Mac) | Generated JPEG previews for HEIC/DNG files |
| `gps-cache.json` | Same app data folder as thumbnails | Cached EXIF scan results — speeds up re-scans of large folders |
| Settings | Same app data folder | API key, folder path, sidebar width, global pin colour |

### Thumbnail Generation
Thumbnails for formats the browser can display natively (JPEG, PNG, WebP, AVIF) are served directly from the original file — no copy is made. For HEIC, HEIF, and DNG files, a JPEG preview is generated in a background worker thread and cached. The cache path for a given file is a SHA-256 hash of the file path, so filenames cannot be guessed from the cache.

### GPS Coordinate Override Design
Manual GPS overrides are stored in `photo-map-data.json` under the key `gpsOverride: { lat, lng }` for each photo. The renderer holds the authoritative state in memory; every operation that changes coordinates immediately calls `saveMetadata()` to flush to disk. The original EXIF coordinates from the photo file are always used as the fallback when no override is present — the override is a layer on top, not a replacement.

### Rename Safety
When a file is renamed, the renderer re-keys all in-memory annotation data to the new filename and then writes the complete metadata to disk in a single `saveMetadata()` call. The GPS override, note, bad-GPS flag, and pin colour all follow the file to its new name. The GPS scan cache is also re-keyed in the main process.

### Modifying the App

**Add a new supported photo file type**
Open `src/utils.js` and add the extension to the `SUPPORTED_EXTENSIONS` Set. If the browser cannot display the format natively, also add it to `FULL_RES_EXTENSIONS` in `src/main/thumbnail-worker.js` so that a full-resolution thumbnail is generated instead of a resized one.

**Change the pin icon or colour**
Open `src/renderer/map.js` and find the `createPinIcon` function. Change the emoji or HTML. Adjust the `.photo-pin-circle` rule in `src/renderer/styles.css` for sizing and positioning.

**Change map label appearance**
Edit the `.map-label` rule in `src/renderer/styles.css`.

**Add a new per-photo annotation field**
1. Add the field to the default object in `getPhotoMeta()` in `src/renderer/metadata.js`.
2. Add a UI control in the info panel section of `index.html`.
3. Wire up save/load logic in `src/renderer/infoPanel.js` following the pattern used by `note` or `badGps`.
4. The new field is automatically included in `photo-map-data.json`.

**App settings storage location**
Settings (API key, folder, sidebar width, pin colour) are stored by `electron-store` in the OS app-data folder:
- **Windows:** `%APPDATA%\photo-map\`
- **macOS:** `~/Library/Application Support/photo-map/`
- **Linux:** `~/.config/photo-map/`

### Custom App Icons
Placeholder icons are in `assets/icons/`. To replace them:
- **macOS:** Replace `assets/icons/icon.icns`. Build a `.icns` from a 1024×1024 PNG using `iconutil`.
- **Windows:** Replace `assets/icons/icon.ico` with a multi-size ICO file.
- **Linux:** Replace `assets/icons/icon_linux.png` with a 512×512 PNG.

Run `npm run build` after replacing icons.

---

## About

Build 2.0.1 · 2026-05-18
Built by Alex Tyler & Claude

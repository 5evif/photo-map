'use strict';

/*
 * export-format.js — Pure GeoJSON and CSV builders
 *
 * Extracted from the "export-data" IPC handler in main.js so the data-
 * transformation logic is testable independently of Electron's dialog API
 * and the filesystem write.
 *
 * Both functions are pure: given the same inputs they always produce the
 * same output and cause no side effects.
 */

const { csvEscape } = require('../utils.js');

/*
 * Builds a GeoJSON FeatureCollection string from the given photos.
 *
 * GeoJSON coordinate order is [longitude, latitude] — the opposite of the
 * common (lat, lng) convention.  This matches RFC 7946 §3.1.1.
 *
 * Input:  photos   — array of { filePath, filename, lat, lng, date }
 *         metadata — { photos: { [filePath]: { note, badGps, pinColor } } }
 * Returns: JSON string
 */
function buildGeoJson(photos, metadata) {
  const photoMeta = (metadata && metadata.photos) || {};
  const features  = photos.map(p => {
    const pm = photoMeta[p.filePath] || {};
    return {
      type:     'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        filename: p.filename,
        filePath: p.filePath,
        date:     p.date     || null,
        note:     pm.note    || '',
        badGps:   pm.badGps  || false,
        pinColor: pm.pinColor || null
      }
    };
  });
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

/*
 * Builds a CSV string from the given photos.
 *
 * Columns: filename, latitude, longitude, date, note, bad_gps
 * String fields are RFC 4180 quoted (double-quotes doubled).
 *
 * Input:  photos   — array of { filePath, filename, lat, lng, date }
 *         metadata — { photos: { [filePath]: { note, badGps } } }
 * Returns: CSV string (header + one row per photo, newline-separated)
 */
function buildCsv(photos, metadata) {
  const photoMeta = (metadata && metadata.photos) || {};
  const header    = ['filename', 'latitude', 'longitude', 'date', 'note', 'bad_gps'];
  const rows      = photos.map(p => {
    const pm = photoMeta[p.filePath] || {};
    return [
      csvEscape(p.filename),
      p.lat,
      p.lng,
      csvEscape(p.date || ''),
      csvEscape(pm.note || ''),
      pm.badGps ? 'true' : 'false'
    ].join(',');
  });
  return [header.join(','), ...rows].join('\n');
}

module.exports = { buildGeoJson, buildCsv };

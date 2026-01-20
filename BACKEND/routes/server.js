// routes/location.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const NodeCache = require('node-cache');
const User = require('../models/User');

const DEBUG = Boolean(process.env.DEBUG_LOCATION);
const cache = new NodeCache({ stdTTL: Number(process.env.LOCATION_CACHE_TTL || 60 * 60) });

// dynamic fetch wrapper (works on Node 18+ or with node-fetch installed)
let fetchFn;
if (typeof globalThis.fetch === 'function') fetchFn = globalThis.fetch;
else fetchFn = (...args) => import('node-fetch').then(m => m.default(...args));
const fetch = (...args) => fetchFn(...args);

/* ---------- helper: extract user id ---------- */
function getUserIdFromReq(req) {
  if (req.user && req.user.id) return String(req.user.id);
  const hdr = req.headers['x-user-id'];
  if (hdr) return String(hdr);
  if (req.body && req.body.userId) return String(req.body.userId);
  if (req.query && req.query.userId) return String(req.query.userId);

  // optional: try Bearer token decode if JWT_SECRET and jsonwebtoken available
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const token = auth.slice(7).trim();
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload && (payload.id || payload.userId)) return String(payload.id || payload.userId);
    } catch (e) {
      if (DEBUG) console.debug('getUserIdFromReq: jwt verify failed', e.message);
    }
  }

  return null;
}

/* ---------- Normalize options (accept lots of shapes) ---------- */
function normalizeOptions(rawArr = []) {
  if (!Array.isArray(rawArr)) return [];
  return rawArr.map(o => {
    const lat = Number(o.lat ?? o.latitude ?? (o.center && o.center.lat));
    const lng = Number(o.lng ?? o.lon ?? o.longitude ?? (o.center && o.center.lon));
    const distanceCandidate = o.distance_m ?? o.distance ?? o.dist ?? null;
    const distance_m = distanceCandidate != null ? Number(distanceCandidate) : null;
    return {
      id: o.id || o.place_id || null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      // prefer structured address-like fields but fall back to name
      address: o.address || o.display_name || o.name || null,
      distance_m: Number.isFinite(distance_m) ? distance_m : null,
      raw: o
    };
  }).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng));
}

/* ---------- geometry helpers ---------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon, yi = polygon[i].lat;
    const xj = polygon[j].lon, yj = polygon[j].lat;
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function elementContainsPoint(el, lat, lon) {
  if (Array.isArray(el.geometry) && el.geometry.length >= 3) {
    return pointInPolygon(lat, lon, el.geometry);
  }
  return false;
}

/* ---------- Overpass geometry fetch (relations/ways) ---------- */
async function overpassTalukasGeom(lat, lon, radiusMeters = 20000, adminLevels = [6,7,8]) {
  const key = `talukas_geom:${lat.toFixed(5)},${lon.toFixed(5)},${radiusMeters},al${adminLevels.join('-')}`;
  if (cache.has(key)) {
    if (DEBUG) console.debug('overpass cache hit', key);
    return cache.get(key);
  }

  const adminLevelFilters = adminLevels.map(l => `["admin_level"="${l}"]`).join('');
  const q = `
[out:json][timeout:60];
(
  relation(around:${radiusMeters},${lat},${lon})["boundary"="administrative"]${adminLevelFilters};
  way(around:${radiusMeters},${lat},${lon})["boundary"="administrative"]${adminLevelFilters};
);
out geom tags;
`;

  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: q });
    if (!resp.ok) {
      if (DEBUG) console.warn('overpass non-ok', resp.status);
      return [];
    }
    const j = await resp.json();
    if (!j.elements) return [];
    const elems = j.elements.map(el => {
      const tags = el.tags || {};
      let plat = null, plon = null;
      if (el.type === 'node') { plat = el.lat; plon = el.lon; }
      else if (el.center) { plat = el.center.lat; plon = el.center.lon; }
      else if (el.bounds) { plat = (el.bounds.minlat + el.bounds.maxlat) / 2; plon = (el.bounds.minlon + el.bounds.maxlon) / 2; }
      return {
        id: `${el.type}/${el.id}`,
        name: tags.name || tags['name:en'] || '(unnamed)',
        admin_level: tags.admin_level ? String(tags.admin_level) : null,
        tags,
        lat: plat, lon: plon,
        geometry: Array.isArray(el.geometry) ? el.geometry.map(p => ({ lat: p.lat, lon: p.lon })) : null
      };
    }).filter(e => e.lat !== null || e.geometry);

    cache.set(key, elems);
    if (DEBUG) console.debug('overpass fetched', key, elems.length, 'elements');
    return elems;
  } catch (err) {
    if (DEBUG) console.warn('Overpass geom error:', err && err.message);
    return [];
  }
}

/* ---------- POST /api/location/candidates (Overpass-powered) ---------- */
router.post('/candidates', async (req, res) => {
  try {
    const body = req.body || {};
    const { latitude, longitude, accuracy, includeAdminLevels, maxRadius } = body;
    const lat = Number(latitude), lon = Number(longitude);
    if (!isFinite(lat) || !isFinite(lon)) return res.status(400).json({ success:false, message:"latitude & longitude required" });

    const adminLevels = Array.isArray(includeAdminLevels) && includeAdminLevels.length
      ? includeAdminLevels.map(Number).filter(n => !Number.isNaN(n))
      : [6,7,8];

    let baseRadius = isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : 2000;
    baseRadius = Math.max(500, baseRadius);

    const envMax = Number(process.env.MAX_RADIUS_METERS || 200000);
    const bodyMax = Number.isFinite(Number(maxRadius)) ? Number(maxRadius) : NaN;
    const maxRadiusAllowed = Number.isFinite(bodyMax) ? Math.max(baseRadius, bodyMax) : Math.max(baseRadius, envMax);

    const degLat = baseRadius / 111000;
    const degLon = baseRadius / (111000 * Math.cos(lat * Math.PI/180));

    const probeFactor = 0.6;
    const probes = [
      { name: "center", dy: 0, dx: 0 },
      { name: "N", dy: 1 * probeFactor, dx: 0 },
      { name: "S", dy: -1 * probeFactor, dx: 0 },
      { name: "E", dy: 0, dx: 1 * probeFactor },
      { name: "W", dy: 0, dx: -1 * probeFactor },
      { name: "NE", dy: 0.7071 * probeFactor, dx: 0.7071 * probeFactor },
      { name: "NW", dy: 0.7071 * probeFactor, dx: -0.7071 * probeFactor },
      { name: "SE", dy: -0.7071 * probeFactor, dx: 0.7071 * probeFactor },
      { name: "SW", dy: -0.7071 * probeFactor, dx: -0.7071 * probeFactor }
    ];

    const selected = [];
    const chosenIds = new Set();
    const TARGET = Number(process.env.LOCATION_TARGET || 4);

    for (const probe of probes) {
      if (selected.length >= TARGET) break;

      const platProbe = lat + probe.dy * degLat;
      const plonProbe = lon + probe.dx * degLon;

      const perProbeNearest = [];
      let foundForProbe = null;

      for (let k = 0; ; k++) {
        const r = baseRadius * Math.pow(2, k);
        if (r > maxRadiusAllowed) break;

        const elems = await overpassTalukasGeom(platProbe, plonProbe, Math.round(r), adminLevels);
        if (!Array.isArray(elems) || elems.length === 0) continue;

        for (const el of elems) {
          if (el.lat && el.lon) {
            const dist = Math.round(haversine(lat, lon, el.lat, el.lon) || 0);
            perProbeNearest.push({ id: el.id, name: el.name, admin_level: el.admin_level, tags: el.tags, lat: el.lat, lon: el.lon, distance_m: dist });
          }
        }

        let containedCandidate = null;
        for (const el of elems) {
          if (el.geometry && el.geometry.length >= 3) {
            try {
              if (elementContainsPoint(el, lat, lon)) {
                containedCandidate = el;
                break;
              }
            } catch (e) { /* ignore geometry parse errors */ }
          }
        }

        if (containedCandidate) {
          if (!chosenIds.has(containedCandidate.id)) {
            const dist = Math.round(haversine(lat, lon, containedCandidate.lat, containedCandidate.lon) || 0);
            foundForProbe = { id: containedCandidate.id, name: containedCandidate.name, admin_level: containedCandidate.admin_level, tags: containedCandidate.tags, lat: containedCandidate.lat, lon: containedCandidate.lon, distance_m: dist, probe: probe.name, found_radius: Math.round(r) };
            chosenIds.add(containedCandidate.id);
          }
          break;
        }
      } // end doubling

      if (!foundForProbe) {
        perProbeNearest.sort((a,b) => (a.distance_m||0) - (b.distance_m||0));
        let pick = null;
        for (const cand of perProbeNearest) {
          if (!chosenIds.has(cand.id)) { pick = cand; break; }
        }
        if (!pick && perProbeNearest.length > 0) pick = perProbeNearest[0];
        if (pick) {
          foundForProbe = { ...pick, probe: probe.name, found_radius: null };
          if (foundForProbe.id) chosenIds.add(foundForProbe.id);
        }
      }

      if (foundForProbe) {
        selected.push(foundForProbe);
      }
    } // end probes

    selected.sort((a,b) => {
      const a6 = a.admin_level === '6' ? 0 : 1;
      const b6 = b.admin_level === '6' ? 0 : 1;
      if (a6 !== b6) return a6 - b6;
      return (a.distance_m || 0) - (b.distance_m || 0);
    });

    const final = selected.slice(0, TARGET);

    return res.json({
      success: true,
      source: "overpass_talukas_8quadrant_faststop",
      requested_center: { lat, lon, base_radius: baseRadius },
      admin_levels_queried: adminLevels,
      max_radius_allowed: maxRadiusAllowed,
      returned_count: final.length,
      talukas: final
    });
  } catch (err) {
    if (DEBUG) console.error("candidates error:", err && err.message);
    return res.status(500).json({ success:false, message: err && err.message });
  }
});

/* ---------- POST /api/location/options ---------- */
router.post('/options', async (req, res) => {
  try {
    if (DEBUG) {
      console.debug('>>> /api/location/options headers:', {
        authorization: req.headers.authorization,
        'x-user-id': req.headers['x-user-id']
      });
      console.debug('>>> /api/location/options body (truncated):', JSON.stringify(req.body || {}).slice(0, 2000));
    }

    const userId = getUserIdFromReq(req);
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      if (DEBUG) console.warn('POST /options invalid userId:', userId);
      return res.status(400).json({ success:false, message:'valid userId required' });
    }

    const raw = Array.isArray(req.body.options) ? req.body.options : (req.body.locationOptions || []);
    const options = normalizeOptions(raw);
    if (!options.length) {
      if (DEBUG) console.warn('POST /options — normalizeOptions returned empty array. raw sample:', raw[0] || null);
      return res.status(400).json({ success:false, message:'options must be a non-empty array with lat & lng' });
    }

    const doc = await User.findByIdAndUpdate(
      userId,
      { $set: { locationOptions: options, updatedAt: new Date() } },
      { new: true, upsert: false }
    ).lean();

    if (!doc) {
      console.warn(`POST /api/location/options — user ${userId} not found`);
      return res.status(404).json({ success: false, message: 'user not found', code: 'user_not_found' });
    }

    return res.json({ success: true, savedCount: options.length, locationOptions: doc.locationOptions });
  } catch (err) {
    console.error('POST /api/location/options error:', err);
    return res.status(500).json({ success:false, message: err.message });
  }
});

/* ---------- GET /api/location/options ---------- */
router.get('/options', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success:false, message:'valid userId required' });
    }

    const doc = await User.findById(userId).lean();
    return res.json({ success: true, locationOptions: doc?.locationOptions || [], chosenLocation: doc?.chosenLocation || null });
  } catch (err) {
    console.error('GET /api/location/options error:', err);
    return res.status(500).json({ success:false, message: err.message });
  }
});

/* ---------- POST /api/location/choice ---------- */
router.post('/choice', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success:false, message:'valid userId required' });
    }

    const choice = req.body.choice || req.body.chosen || req.body;
    if (!choice || !Number.isFinite(Number(choice.lat)) || !Number.isFinite(Number(choice.lng))) {
      return res.status(400).json({ success:false, message:'choice must include numeric lat & lng' });
    }

    const normalized = {
      id: choice.id || null,
      lat: Number(choice.lat),
      lng: Number(choice.lng),
      address: choice.address || choice.name || null,
      raw: choice.raw || choice,
      chosenAt: new Date()
    };

    const doc = await User.findByIdAndUpdate(
      userId,
      { $set: { chosenLocation: normalized, updatedAt: new Date() } },
      { new: true, upsert: false }
    ).lean();

    if (!doc) {
      console.warn(`POST /api/location/choice — user ${userId} not found`);
      return res.status(404).json({ success: false, message: 'user not found', code: 'user_not_found' });
    }

    return res.json({ success:true, chosenLocation: doc.chosenLocation });
  } catch (err) {
    console.error('POST /api/location/choice error:', err);
    return res.status(500).json({ success:false, message: err.message });
  }
});

/* ---------- GET /api/location/choice ---------- */
router.get('/choice', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success:false, message:'valid userId required' });
    }

    const doc = await User.findById(userId).lean();
    return res.json({ success:true, chosenLocation: doc?.chosenLocation || null });
  } catch (err) {
    console.error('GET /api/location/choice error:', err);
    return res.status(500).json({ success:false, message: err.message });
  }
});

module.exports = router;

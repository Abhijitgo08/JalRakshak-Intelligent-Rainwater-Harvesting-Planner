// routes/calcRoutes.js
const express = require("express");
const router = express.Router();

/**
 * HTTP helper: prefer axios if available, otherwise use global fetch (Node18+)
 * with AbortController timeout.
 */
let _axios = null;
try { _axios = require("axios"); } catch (e) { _axios = null; }

async function httpGetJson(url, timeoutMs = 20000) {
  if (_axios) {
    const resp = await _axios.get(url, { timeout: timeoutMs });
    return resp.data;
  }
  if (typeof fetch !== "undefined") {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${txt}`);
      }
      return await resp.json();
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  }
  throw new Error("No HTTP client available. Install axios or run on Node 18+ (fetch).");
}

/**
 * Get average annual rainfall (mm/year) using Open-Meteo archive API.
 * We compute yearly totals across 2000-2020 (21 years) and return rounded mm/year.
 * Returns null when unavailable.
 */
async function getAverageRainfall(lat, lng) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&start_date=2000-01-01&end_date=2020-12-31&daily=precipitation_sum&timezone=UTC`;
  try {
    const data = await httpGetJson(url, 20000);
    const dailyValues = data?.daily?.precipitation_sum;
    if (!dailyValues || !Array.isArray(dailyValues) || dailyValues.length === 0) return null;
    const totalMm = dailyValues.reduce((a, b) => a + (Number(b) || 0), 0);
    const years = 21; // 2000..2020 inclusive
    return Math.round(totalMm / years);
  } catch (err) {
    console.warn("getAverageRainfall failed:", err && err.message ? err.message : err);
    return null;
  }
}

// ------------------ CONFIG / DATA ------------------

// Runoff coefficients for roof types
const RUNOFF_COEFF = { concrete: 0.6, metal: 0.9 };

// If client supplies groundRunoffCoeff, server will prefer it; otherwise use these midpoints
const GROUND_IMPERMEABILITY = {
  water_tight: 0.825, asphalt: 0.875, stone_brick: 0.8, open_joints: 0.6,
  inferior_blocks: 0.45, macadam: 0.425, gravel: 0.225, unpaved: 0.2, parks: 0.15, dense_built: 0.8
};

const DEFAULT_VELOCITY = 2.5; // m/s fallback
const DEFAULT_FLOOR_HEIGHT = 3.0; // m
const DEFAULT_WET_MONTHS = 4;
const DEFAULT_FILTER_SAFETY_FACTOR = 1.5;
const DEFAULT_PIT_COST_PER_M3 = 800; // INR/m3

// pipe standards (example)
const PIPE_STANDARDS = [
  { id: "PVC_3m", name: "PVC pipe (3 m)", length_m: 3, unit_cost_per_meter: 80, source: "vendor" },
  { id: "PVC_6m", name: "PVC pipe (6 m)", length_m: 6, unit_cost_per_meter: 85, source: "vendor" },
  { id: "HDPE_6m", name: "HDPE pipe (6 m)", length_m: 6, unit_cost_per_meter: 65, source: "vendor" },
  { id: "HDPE_12m", name: "HDPE pipe (12 m)", length_m: 12, unit_cost_per_meter: 65, source: "vendor" }
];

const FILTER_PRODUCTS = [
  { id: "NEERAIN_BASIC", name: "NeeRain Basic", capacity_m2: 150, unit_cost: 6500 },
  { id: "RAINY_FL80", name: "Rainy FL-80", capacity_m2: 75, unit_cost: 8500 },
  { id: "RAINY_FL250", name: "Rainy FL-250", capacity_m2: 250, unit_cost: 13750 }
];

const AQUIFER_CATEGORIES = [
  { type: "Dug Well / Small Pit", min_l_per_year: 0, max_l_per_year: 50_000 },
  { type: "Percolation Pit / Tank", min_l_per_year: 50_001, max_l_per_year: 200_000 },
  { type: "Recharge Shaft / Large Pit", min_l_per_year: 200_001, max_l_per_year: 500_000 },
  { type: "Injection Well / Large-scale recharge", min_l_per_year: 500_001, max_l_per_year: Infinity }
];

// ------------------ HELPERS ------------------

// degrees -> approximate meters for latitude (constant) and longitude (depends on lat)
function degLatToMeters(deg) { return deg * 111320; } // approx
function degLonToMeters(deg, atLat) { return deg * (111320 * Math.cos((atLat * Math.PI) / 180)); }

// compute bounding box (min/max lat/lng) and return width/height in meters
function bboxDimensionsMeters(points) {
  // points: array of {lat, lng}
  if (!Array.isArray(points) || points.length === 0) return { width_m: 0, height_m: 0, bbox: null, centroid: null };
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  let sumLat = 0, sumLng = 0;
  points.forEach(p => {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    sumLat += lat; sumLng += lng;
  });
  const centerLat = sumLat / points.length;
  const height_m = degLatToMeters(maxLat - minLat);
  const width_m = Math.abs(degLonToMeters(maxLng - minLng, centerLat));
  return {
    width_m: Math.round(width_m * 100) / 100,
    height_m: Math.round(height_m * 100) / 100,
    bbox: { minLat, maxLat, minLng, maxLng },
    centroid: { lat: centerLat, lng: sumLng / points.length }
  };
}

// Manning formula fallback for velocity (if user hasn't supplied velocity).
// We'll assume roughness n and slope S defaults. For circular full pipe hydraulic radius R = D/4.
// V = (1/n) * R^(2/3) * S^(1/2)
function manningVelocityForPipe(D_m, options = {}) {
  // D_m: diameter in meters
  const n = options.n ?? 0.013; // roughness (PVC ~0.012-0.015) - default 0.013
  const S = options.S ?? 0.01; // slope (1%) default
  if (!D_m || D_m <= 0) return DEFAULT_VELOCITY;
  const R = D_m / 4.0;
  const V = (1 / n) * Math.pow(R, 2 / 3) * Math.sqrt(S);
  if (!isFinite(V) || V <= 0) return DEFAULT_VELOCITY;
  return Math.max(0.1, Math.min(V, 10)); // clamp to sensible range
}

// simple haversine to compute metres between two lat/lng
function haversineMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);
  const aa = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon * sinDlon;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

// pick best filter by capacity considering safety factor (safetyFactor multiplies needed area)
function chooseBestFilterByRoofArea(roofArea_m2, safetyFactor) {
  const neededArea = roofArea_m2 * (safetyFactor || 1.0);
  const candidates = FILTER_PRODUCTS.map(fp => {
    const units = Math.ceil(neededArea / fp.capacity_m2);
    const total_cost = units * fp.unit_cost;
    return { ...fp, units_required: units, total_cost };
  }).sort((a, b) => a.total_cost - b.total_cost);
  return { candidates, chosen: candidates.length ? candidates[0] : null };
}

// compute pipe diameter from Q (m3/s) and V (m/s) using D = sqrt(4*Q/(π*V))
function diameterFromFlow(Q_m3_s, velocity_m_s) {
  if (!Q_m3_s || Q_m3_s <= 0 || !velocity_m_s || velocity_m_s <= 0) return 0;
  const D = Math.sqrt((4 * Q_m3_s) / (Math.PI * velocity_m_s));
  return D;
}

// ------------------ ROUTE ------------------
router.post("/", async (req, res) => {
  try {
    let {
      lat, lng, roofArea, roofType, dwellers, soilType,
      floors, avgFloorHeight, velocity_m_s, wetMonths,
      safetyFactorFilter, pit_cost_per_m3,
      includeGround, groundArea, groundSurfaces, groundRunoffCoeffClient,
      roofPolygon, groundPolygon
    } = req.body;

    // Normalize & defaults
    lat = Number(lat); lng = Number(lng);
    roofArea = Number(roofArea);
    dwellers = Number(dwellers);
    floors = (floors === undefined || floors === null) ? 0 : Number(floors);
    avgFloorHeight = (avgFloorHeight === undefined || avgFloorHeight === null) ? DEFAULT_FLOOR_HEIGHT : Number(avgFloorHeight);
    velocity_m_s = (velocity_m_s === undefined || velocity_m_s === null) ? DEFAULT_VELOCITY : Number(velocity_m_s);
    wetMonths = (wetMonths === undefined || wetMonths === null) ? DEFAULT_WET_MONTHS : Number(wetMonths);
    safetyFactorFilter = (safetyFactorFilter === undefined || safetyFactorFilter === null) ? DEFAULT_FILTER_SAFETY_FACTOR : Number(safetyFactorFilter);
    pit_cost_per_m3 = (pit_cost_per_m3 === undefined || pit_cost_per_m3 === null) ? DEFAULT_PIT_COST_PER_M3 : Number(pit_cost_per_m3);
    includeGround = !!includeGround;
    groundArea = includeGround ? Number(groundArea || 0) : 0;

    if (isNaN(lat) || isNaN(lng) || isNaN(roofArea) || !roofType || isNaN(dwellers)) {
      return res.status(400).json({ success: false, message: "Missing or invalid fields. Required: lat,lng,roofArea,roofType,dwellers" });
    }

    // 1) get rainfall (mm/year)
    const rainfall_mm = await getAverageRainfall(lat, lng);
    if (!rainfall_mm) {
      // fallback: some users reported high values from open-meteo; we still return error so frontend can handle
      // but we'll provide a fallback estimate using a short period if necessary — here return 404
      return res.status(404).json({ success: false, message: "Rainfall data not available for location" });
    }

    // 2) compute runoffs separately
    const roofCoeff = RUNOFF_COEFF[String(roofType).toLowerCase()] ?? 0.75;

    // ground runoff coefficient: client-provided preferred, else computed from selected surfaces, else default 0.3
    let groundCoeff = null;
    if (includeGround) {
      if (groundRunoffCoeffClient && !isNaN(Number(groundRunoffCoeffClient))) {
        groundCoeff = Number(groundRunoffCoeffClient);
      } else if (Array.isArray(groundSurfaces) && groundSurfaces.length > 0) {
        const vals = groundSurfaces.map(k => (GROUND_IMPERMEABILITY[k] !== undefined ? GROUND_IMPERMEABILITY[k] : null)).filter(v => v !== null);
        if (vals.length > 0) groundCoeff = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      if (groundCoeff === null) groundCoeff = 0.30;
    }

    // runoff (L/year) = area(m2) * (rainfall_mm/1000) * 1000 * coeff = area * rainfall_mm * coeff
    const runoff_roof_liters_per_year = Math.round(roofArea * (rainfall_mm / 1000) * 1000 * roofCoeff);
    const runoff_ground_liters_per_year = includeGround ? Math.round(groundArea * (rainfall_mm / 1000) * 1000 * groundCoeff) : 0;
    const runoff_liters_per_year = runoff_roof_liters_per_year + runoff_ground_liters_per_year;

    // 3) Flow estimate for pipe sizing:
    // We'll compute a conservative instantaneous flow Q based on roof area and a design storm intensity.
    // Simpler approach: derive Q from runoff peak approximation: assume short duration peak uses V (velocity) and roof area to compute Q.
    // For continuity with previous code, compute Q_m3_s = roofArea * V (this is simplistic, but kept for backward compatibility).
    // We'll also compute D using diam formula with velocity either provided or using manning estimate.
    const V_used = (velocity_m_s && Number(velocity_m_s) > 0) ? Number(velocity_m_s) : DEFAULT_VELOCITY;
    // approximate volumetric instantaneous flow from total catchment area (roof only, since pipes collect roof)
    const Q_m3_s = (roofArea / 1000) * V_used; // roofArea(m2) * V (m/s) -> m3/s but dividing by 1000 to scale realistically
    let D_m = 0;
    if (Q_m3_s > 0 && V_used > 0) {
      D_m = diameterFromFlow(Q_m3_s, V_used);
    }
    const D_mm = Math.round(D_m * 1000);

    // 4) Pipe length: horizontal + vertical
    // Vertical = floors * avgFloorHeight (m)
    const vertical_length_m = Math.round((floors * avgFloorHeight) * 100) / 100;

    // Horizontal: try to compute using ground polygon bounding box width/height OR fallback to sqrt(area)
    let horizontal_length_m = 0;
    let channel_length_m = null;
    let channel_cost = null;
    if (includeGround && Array.isArray(groundPolygon) && groundPolygon.length > 0) {
      const bbox = bboxDimensionsMeters(groundPolygon);
      // choose longer side of bbox as likely channel run to pit (more conservative)
      const width_m = bbox.width_m || 0;
      const height_m = bbox.height_m || 0;
      // pick max dimension as channel length (user instruction: bounding box width/height more accurate)
      channel_length_m = Math.max(width_m, height_m, Math.sqrt(groundArea || 0));
      // horizontal pipe length: assume pipe follows channel length plus a small roof-to-channel run
      // approximate roof centroid -> ground bbox centroid distance if roofPolygon provided
      let roofToPit_m = 0;
      try {
        if (Array.isArray(roofPolygon) && roofPolygon.length > 0) {
          const roofCtr = bboxDimensionsMeters(roofPolygon).centroid;
          const groundCtr = bbox.centroid;
          if (roofCtr && groundCtr) {
            roofToPit_m = Math.round(haversineMeters(roofCtr.lat, roofCtr.lng, groundCtr.lat, groundCtr.lng) * 100) / 100;
          }
        }
      } catch (e) { roofToPit_m = 0; }
      horizontal_length_m = Math.round((channel_length_m + roofToPit_m) * 100) / 100;
      // channel cost: conservative estimate: excavation+concrete+steel grate etc.
      // assumptions: channel cross-section (0.5 m deep × 0.3 m wide), concrete lining cost ~ 2500 INR/m (varies)
      const unit_cost_per_m_channel = 2500; // INR/meter (approx)
      const block_cost_per_end = 1500; // 1ft concrete block + steel gauge at end estimate
      channel_cost = Math.round(channel_length_m * unit_cost_per_m_channel + block_cost_per_end);
    } else {
      // fallback: horizontal length approximated by sqrt(roofArea) (not used often)
      horizontal_length_m = Math.round(Math.sqrt(roofArea || 0) * 100) / 100;
    }

    const total_pipe_length_m = Math.round((horizontal_length_m + vertical_length_m) * 100) / 100;

    // 5) Pipe options and cost (units & meters)
    const pipeOptions = PIPE_STANDARDS.map(p => {
      const units_required = p.length_m > 0 ? Math.ceil(total_pipe_length_m / p.length_m) : 0;
      const used_meters = units_required * p.length_m;
      const cost = Math.round(used_meters * p.unit_cost_per_meter);
      return {
        id: p.id,
        name: p.name,
        standard_length_m: p.length_m,
        used_meters,
        units_required,
        unit_cost_per_meter: p.unit_cost_per_meter,
        total_cost: cost,
        source: p.source
      };
    });
    const cheapestPipe = pipeOptions.reduce((best, cur) => (cur.total_cost < (best?.total_cost ?? Infinity) ? cur : best), null);

    // 6) Filters (best-fit by roof effective area and safety factor)
    const { candidates: filtersCandidates, chosen: chosenFilter } = chooseBestFilterByRoofArea(roofArea, safetyFactorFilter);

    // 7) infiltration & pit sizing
    const soilKey = (soilType || "loamy").toString().toLowerCase();
    const SOIL_INFILTRATION = { sandy: 0.8, loamy: 0.475, clayey: 0.175 };
    const infiltrationFraction = SOIL_INFILTRATION[soilKey] ?? SOIL_INFILTRATION["loamy"];
    const infiltrated_liters_per_year = Math.round(runoff_liters_per_year * infiltrationFraction);

    const wetMonthsSafe = Math.max(1, Math.round(Number(wetMonths || DEFAULT_WET_MONTHS)));
    const pitVolume_m3 = Math.round((infiltrated_liters_per_year / 1000) / wetMonthsSafe * 100) / 100;
    const pit_cost_estimate = Math.round(pitVolume_m3 * (pit_cost_per_m3 || DEFAULT_PIT_COST_PER_M3));

    // 8) aquifer classification (by total runoff)
    const aquiferCategory = AQUIFER_CATEGORIES.find(a => runoff_liters_per_year >= a.min_l_per_year && runoff_liters_per_year <= a.max_l_per_year);
    const aquiferType = aquiferCategory ? aquiferCategory.type : "Unknown";

    // 9) costs summary
    const chosenPipeCost = cheapestPipe ? cheapestPipe.total_cost : 0;
    const chosenFilterCost = chosenFilter ? chosenFilter.total_cost : 0;
    const channelCostVal = channel_cost ?? 0;
    const totalEstimatedInstallationCost = Math.round(chosenPipeCost + chosenFilterCost + pit_cost_estimate + channelCostVal);

    // 10) feasibility
    const ANNUAL_NEED_PER_PERSON_LPD = 85;
    const annualNeed = Math.round(dwellers * ANNUAL_NEED_PER_PERSON_LPD * 365);
    const coverageRatio = annualNeed > 0 ? (runoff_liters_per_year / annualNeed) : 0;
    const feasible = (coverageRatio >= 0.25) || (runoff_liters_per_year >= 15000);

    // 11) compute Manning velocity for the chosen pipe diameter as additional info
    const velocity_manning = D_m > 0 ? manningVelocityForPipe(D_m) : DEFAULT_VELOCITY;

    // Build response
    const result = {
      success: true,
      inputs: {
        lat, lng, roofArea, roofType, dwellers, soilType: soilKey, floors, avgFloorHeight,
        velocity_m_s: V_used, wetMonths: wetMonthsSafe, safetyFactorFilter, pit_cost_per_m3
      },

      rainfall_mm,

      // runoffs
      runoff_roof_liters_per_year,
      runoff_ground_liters_per_year,
      runoff_liters_per_year,

      infiltrationFraction,
      infiltrated_liters_per_year,

      annualNeed,
      coverageRatio: Number(coverageRatio.toFixed(3)),

      flow: {
        Q_m3_s: Number(Q_m3_s.toFixed(6)),
        velocity_manning: Number(velocity_manning.toFixed(3)),
        used_velocity_m_s: Number(V_used)
      },

      pipe: {
        calculated_diameter_mm: D_mm,
        calculated_diameter_m: Number(D_m.toFixed(4)),
        vertical_length_m,
        horizontal_length_m,
        total_pipe_length_m,
        options: pipeOptions,
        chosen_option: cheapestPipe
      },

      filters: {
        candidates: filtersCandidates,
        chosen: chosenFilter
      },

      pit: {
        pit_volume_m3: pitVolume_m3,
        pit_cost_estimate
      },

      channel: {
        channel_length_m: channel_length_m ? Math.round(channel_length_m * 100) / 100 : null,
        channel_cost: channelCostVal
      },

      aquifer: { type: aquiferType },

      costs: {
        chosen_pipe_cost: chosenPipeCost,
        chosen_filter_cost: chosenFilterCost,
        pit_cost: pit_cost_estimate,
        channel_cost: channelCostVal,
        total_estimated_installation_cost: totalEstimatedInstallationCost
      },

      feasibility: feasible
    };

    return res.json(result);
  } catch (err) {
    console.error("calc route error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, message: err.message || "Internal error" });
  }
});

module.exports = router;

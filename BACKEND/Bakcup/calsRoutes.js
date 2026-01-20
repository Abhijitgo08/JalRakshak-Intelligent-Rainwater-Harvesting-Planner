// routes/calcRoutes.js
const express = require("express");
const router = express.Router();

/**
 * Robust HTTP helper:
 * - Prefer axios if installed
 * - Otherwise use global fetch (Node 18+)
 * - Timeout implemented for fetch via AbortController
 */

let _axios = null;
try {
  _axios = require("axios");
} catch (e) {
  _axios = null;
}

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

  throw new Error(
    "No HTTP client available. Install axios or run on Node 18+ (global fetch)."
  );
}

/**
 * Helper: get average annual rainfall from Open-Meteo (archive 2000-2020)
 * Returns mm/year (rounded)
 */
async function getAverageRainfall(lat, lng) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${encodeURIComponent(
    lat
  )}&longitude=${encodeURIComponent(
    lng
  )}&start_date=2000-01-01&end_date=2020-12-31&daily=precipitation_sum&timezone=UTC`;

  const data = await httpGetJson(url, 20000);
  const dailyValues = data?.daily?.precipitation_sum;
  if (!dailyValues || !Array.isArray(dailyValues) || dailyValues.length === 0) {
    return null;
  }
  const totalMm = dailyValues.reduce((a, b) => a + (Number(b) || 0), 0);
  const years = 21; // 2000..2020 inclusive
  return Math.round(totalMm / years);
}

// ------------------ DATASETS / CONFIG ------------------
// Runoff coefficients (existing mapping)
const RUNOFF_COEFF = { concrete: 0.6, metal: 0.9 };

// Soil infiltration fractions (midpoints of thumb rules)
const SOIL_INFILTRATION = { sandy: 0.8, loamy: 0.475, clayey: 0.175 };

// Defaults and constants
const DEFAULT_VELOCITY = 2.5; // m/s (request default)
const DEFAULT_FLOOR_HEIGHT = 3.0; // m
const DEFAULT_WET_MONTHS = 4; // months used to size pit
const DEFAULT_FILTER_SAFETY_FACTOR = 0.8;
const DEFAULT_PIT_COST_PER_M3 = 800; // INR per m3 excavation (configurable)

// Real-ish datasets (example vendor numbers / per-meter costs)
const PIPE_STANDARDS = [
  { id: "PVC_3m", name: "PVC pipe (3 m)", length_m: 3, unit_cost_per_meter: 80, source: "vendor-listing" },
  { id: "PVC_6m", name: "PVC pipe (6 m)", length_m: 6, unit_cost_per_meter: 85, source: "vendor-listing" },
  { id: "HDPE_6m", name: "HDPE pipe (6 m)", length_m: 6, unit_cost_per_meter: 65, source: "vendor-listing" },
  { id: "HDPE_12m", name: "HDPE pipe (12 m)", length_m: 12, unit_cost_per_meter: 65, source: "manufacturer-listing" }
];

const FILTER_PRODUCTS = [
  { id: "RAINY_FL80", name: "Rainy FL-80", capacity_m2: 75, unit_cost: 8500, source: "retailer" },
  { id: "NEERAIN_BASIC", name: "NeeRain Basic", capacity_m2: 150, unit_cost: 6500, source: "retailer" },
  { id: "RAINY_FL250", name: "Rainy FL-250", capacity_m2: 250, unit_cost: 13750, source: "vendor" }
];

const AQUIFER_CATEGORIES = [
  { type: "Dug Well / Small Pit", min_l_per_year: 0, max_l_per_year: 50_000 },
  { type: "Percolation Pit / Tank", min_l_per_year: 50_001, max_l_per_year: 200_000 },
  { type: "Recharge Shaft / Large Pit", min_l_per_year: 200_001, max_l_per_year: 500_000 },
  { type: "Injection Well / Large-scale recharge", min_l_per_year: 500_001, max_l_per_year: Infinity }
];

// ------------------ ROUTE ------------------
router.post("/", async (req, res) => {
  try {
    let {
      lat,
      lng,
      roofArea,
      roofType,
      dwellers,
      soilType,
      floors,
      avgFloorHeight,
      velocity_m_s,
      wetMonths,
      safetyFactorFilter,
      pit_cost_per_m3
    } = req.body;

    // Normalize & defaults
    lat = Number(lat);
    lng = Number(lng);
    roofArea = Number(roofArea);
    dwellers = Number(dwellers);
    floors = (floors === undefined || floors === null) ? 0 : Number(floors);
    avgFloorHeight = (avgFloorHeight === undefined || avgFloorHeight === null) ? DEFAULT_FLOOR_HEIGHT : Number(avgFloorHeight);
    velocity_m_s = (velocity_m_s === undefined || velocity_m_s === null) ? DEFAULT_VELOCITY : Number(velocity_m_s);
    wetMonths = (wetMonths === undefined || wetMonths === null) ? DEFAULT_WET_MONTHS : Number(wetMonths);
    safetyFactorFilter = (safetyFactorFilter === undefined || safetyFactorFilter === null) ? DEFAULT_FILTER_SAFETY_FACTOR : Number(safetyFactorFilter);
    pit_cost_per_m3 = (pit_cost_per_m3 === undefined || pit_cost_per_m3 === null) ? DEFAULT_PIT_COST_PER_M3 : Number(pit_cost_per_m3);

    if (isNaN(lat) || isNaN(lng) || isNaN(roofArea) || !roofType || isNaN(dwellers)) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields. Required: lat, lng, roofArea, roofType, dwellers"
      });
    }

    // 1) average annual rainfall (mm/year) from Open-Meteo
    const rainfall_mm = await getAverageRainfall(lat, lng);
    if (!rainfall_mm) {
      return res.status(404).json({ success: false, message: "Rainfall data not available for location" });
    }

    // 2) Runoff (liters/year)
    const coeff = RUNOFF_COEFF[String(roofType).toLowerCase()] ?? 0.75;
    const runoff_liters_per_year = Math.round(roofArea * (rainfall_mm / 1000) * 1000 * coeff);

    // 3) Flow: Q = Area * V  (m³/s) and L/s
    const V = Number(velocity_m_s) > 0 ? Number(velocity_m_s) : DEFAULT_VELOCITY;
    const Q_m3_s = roofArea * V;
    const Q_l_s = Q_m3_s * 1000;

    // 4) Pipe diameter from D = sqrt(4*Q / (π * V))
    let D_m = 0;
    if (V > 0 && Q_m3_s > 0) {
      D_m = Math.sqrt((4 * Q_m3_s) / (Math.PI * V));
    }
    const D_mm = Math.round(D_m * 1000);

    // 5) Pipe length from floors * avgFloorHeight
    const pipeLength_m = Math.round((floors * avgFloorHeight) * 100) / 100;

    // 6) Pipe options units & cost
    const pipeOptions = PIPE_STANDARDS.map(p => {
      const units_required = p.length_m > 0 ? Math.ceil(pipeLength_m / p.length_m) : 0;
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

    // 7) Filters: pick by capacity with safety factor
    const filtersCalculated = FILTER_PRODUCTS.map(fp => {
      const effective_capacity = fp.capacity_m2 * (safetyFactorFilter || 1);
      const units_required = effective_capacity > 0 ? Math.ceil(roofArea / effective_capacity) : 0;
      const total_cost = units_required * fp.unit_cost;
      return {
        id: fp.id,
        name: fp.name,
        capacity_m2: fp.capacity_m2,
        effective_capacity_per_unit: effective_capacity,
        units_required,
        unit_cost: fp.unit_cost,
        total_cost,
        source: fp.source
      };
    });

    const filtersCandidates = filtersCalculated.filter(f => f.units_required > 0).sort((a, b) => a.total_cost - b.total_cost);
    const chosenFilter = filtersCandidates.length ? filtersCandidates[0] : null;

    // 8) Infiltration (liters/year)
    const soilKey = (soilType || "loamy").toString().toLowerCase();
    const infiltrationFraction = SOIL_INFILTRATION[soilKey] ?? SOIL_INFILTRATION["loamy"];
    const infiltrated_liters_per_year = Math.round(runoff_liters_per_year * infiltrationFraction);

    // 9) Recharge pit sizing & cost
    const wetMonthsSafe = Math.max(1, Math.round(Number(wetMonths || DEFAULT_WET_MONTHS)));
    const pitVolume_m3 = Math.round((infiltrated_liters_per_year / 1000) / wetMonthsSafe * 100) / 100;
    const pit_cost_estimate = Math.round(pitVolume_m3 * (pit_cost_per_m3 || DEFAULT_PIT_COST_PER_M3));

    // 10) Aquifer classification
    const aquiferCategory = AQUIFER_CATEGORIES.find(a => runoff_liters_per_year >= a.min_l_per_year && runoff_liters_per_year <= a.max_l_per_year);
    const aquiferType = aquiferCategory ? aquiferCategory.type : "Unknown";

    // 11) Cost summary
    const chosenPipeCost = cheapestPipe ? cheapestPipe.total_cost : 0;
    const chosenFilterCost = chosenFilter ? chosenFilter.total_cost : 0;
    const totalEstimatedInstallationCost = Math.round(chosenPipeCost + chosenFilterCost + pit_cost_estimate);

    // 12) Feasibility flag (no advice)
    const ANNUAL_NEED_PER_PERSON_LPD = 85;
    const annualNeed = Math.round(dwellers * ANNUAL_NEED_PER_PERSON_LPD * 365);
    const coverageRatio = annualNeed > 0 ? (runoff_liters_per_year / annualNeed) : 0;
    const feasible = (coverageRatio >= 0.25) || (runoff_liters_per_year >= 15000);

    const result = {
      success: true,
      inputs: {
        lat, lng, roofArea, roofType, dwellers,
        soilType: soilKey, floors, avgFloorHeight,
        velocity_m_s: V, wetMonths: wetMonthsSafe,
        safetyFactorFilter, pit_cost_per_m3
      },
      rainfall_mm,
      runoff_liters_per_year,
      infiltrationFraction,
      infiltrated_liters_per_year,
      annualNeed,
      coverageRatio: Number(coverageRatio.toFixed(3)),

      flow: {
        Q_m3_s: Number(Q_m3_s.toFixed(6)),
        Q_l_s: Math.round(Q_l_s)
      },

      pipe: {
        calculated_diameter_mm: D_mm,
        pipe_length_m: pipeLength_m,
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

      aquifer: {
        type: aquiferType
      },

      costs: {
        chosen_pipe_cost: chosenPipeCost,
        chosen_filter_cost: chosenFilterCost,
        pit_cost: pit_cost_estimate,
        total_estimated_installation_cost: totalEstimatedInstallationCost
      },

      feasibility: feasible
    };

    return res.json(result);
  } catch (err) {
    console.error("calc route error:", err);
    return res.status(500).json({ success: false, message: err.message || "Internal error" });
  }
});

module.exports = router;

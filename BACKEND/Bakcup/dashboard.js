// dashboard.js — complete file with floors & soil, improved suggestion & PDF
// Requires: leaflet, leaflet-draw, turf, html2canvas, jsPDF (your HTML already includes them)

// ----------------- ELEMENTS -----------------
const analyzeBtn = document.getElementById("analyzeBtn");
const analysisResult = document.getElementById("analysisResult");
const designCard = document.getElementById("designCard");
const outputCard = document.getElementById("outputCard");
const userName = document.getElementById("userName");
const roofAreaSpan = document.getElementById("roofArea");

const locationSelect = document.getElementById("locationSelect");
const locationMeta = document.getElementById("locationMeta");

// ===== CONFIG =====
const API_BASE = (location.hostname === 'localhost') ? 'http://localhost:10000' : '';
const token = localStorage.getItem("token");
if (!token) window.location.href = "auth.html";
userName.textContent = localStorage.getItem("userName") || "User";

// ----------------- INTERNAL DEFAULTS -----------------
const DEFAULTS = {
  avgFloorHeight: 3.0,
  velocity_m_s: 2.5,
  wetMonths: 4,
  safetyFactorFilter: 0.8,
  pit_cost_per_m3: 800
};

// ----------------- MAP SETUP -----------------
const map = L.map("map").setView([18.5204, 73.8567], 13);

const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19
});
const esriSat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics",
  maxNativeZoom: 17,
  maxZoom: 20
});
const esriLabels = L.tileLayer("https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Labels © Esri",
  maxNativeZoom: 17,
  maxZoom: 20
});
osm.addTo(map);

map.on('zoomend', () => {
  const z = map.getZoom();
  if (z >= 14 && z <= 20) {
    if (!map.hasLayer(esriSat)) {
      if (map.hasLayer(osm)) map.removeLayer(osm);
      esriSat.addTo(map);
      esriLabels.addTo(map);
    }
  } else {
    if (!map.hasLayer(osm)) {
      if (map.hasLayer(esriSat)) map.removeLayer(esriSat);
      if (map.hasLayer(esriLabels)) map.removeLayer(esriLabels);
      osm.addTo(map);
    }
  }
});

// Draw control (single polygon)
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);
const drawControl = new L.Control.Draw({
  draw: {
    polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false,
    polygon: { allowIntersection: false, showArea: true, showLength: false }
  },
  edit: { featureGroup: drawnItems }
});
map.addControl(drawControl);

// turf helper
function latlngsToTurfPolygon(latlngs) {
  const coords = latlngs.map((p) => [p.lng, p.lat]);
  if (coords.length && (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1])) {
    coords.push(coords[0]);
  }
  return turf.polygon([coords]);
}

// drawing events
map.on(L.Draw.Event.CREATED, (e) => {
  drawnItems.clearLayers();
  const layer = e.layer;
  drawnItems.addLayer(layer);
  const latlngs = layer.getLatLngs()[0];
  try {
    const poly = latlngsToTurfPolygon(latlngs);
    const area = turf.area(poly);
    window.selectedRoofArea = Math.round(area);
    roofAreaSpan.textContent = window.selectedRoofArea;
  } catch (err) {
    console.warn("Area calc failed", err);
    if (L.GeometryUtil && typeof L.GeometryUtil.geodesicArea === "function") {
      const fallback = L.GeometryUtil.geodesicArea(latlngs);
      window.selectedRoofArea = Math.round(fallback);
      roofAreaSpan.textContent = window.selectedRoofArea;
    } else {
      window.selectedRoofArea = 0;
      roofAreaSpan.textContent = 0;
    }
  }
});
map.on(L.Draw.Event.EDITED, (e) => {
  const layers = e.layers;
  layers.eachLayer((layer) => {
    const latlngs = layer.getLatLngs()[0];
    try {
      const poly = latlngsToTurfPolygon(latlngs);
      const area = turf.area(poly);
      window.selectedRoofArea = Math.round(area);
      roofAreaSpan.textContent = window.selectedRoofArea;
    } catch (err) {
      console.warn("Edited area calc fallback", err);
      window.selectedRoofArea = window.selectedRoofArea || 0;
    }
  });
});

// ----------------- LOCATION helpers -----------------
function showLocationMeta(loc) {
  if (!locationMeta) return;
  if (!loc) {
    locationMeta.classList.add('hidden');
    locationMeta.textContent = '';
    return;
  }
  locationMeta.classList.remove('hidden');
  locationMeta.textContent = `${loc.address || 'Unknown'} — lat:${loc.lat ?? 'N/A'}, lng:${loc.lng ?? 'N/A'}`;
}

function populateLocationSelect(options = [], chosenLocation = null) {
  if (!locationSelect) return;
  locationSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Select Location --';
  locationSelect.appendChild(placeholder);

  options.forEach((loc, i) => {
    const opt = document.createElement('option');
    const idStr = (loc && loc.id) ? String(loc.id) : ('loc_' + i);
    opt.value = idStr;
    opt.textContent = loc.address || (loc.lat !== undefined && loc.lng !== undefined ? `${loc.lat}, ${loc.lng}` : `Location ${i+1}`);
    opt.dataset.loc = JSON.stringify({
      id: idStr,
      address: loc.address || null,
      lat: loc.lat ?? null,
      lng: loc.lng ?? null,
      raw: loc.raw ?? null,
      distance_m: loc.distance_m ?? null
    });
    locationSelect.appendChild(opt);
  });

  if (chosenLocation) {
    const chosenId = (chosenLocation.id !== undefined) ? String(chosenLocation.id) : null;
    for (let i = 0; i < locationSelect.options.length; i++) {
      const o = locationSelect.options[i];
      if (!o.dataset.loc) continue;
      try {
        const L = JSON.parse(o.dataset.loc);
        if (chosenId && String(L.id) === chosenId) {
          locationSelect.selectedIndex = i;
          showLocationMeta(L);
          break;
        }
        if (chosenLocation.lat !== undefined && chosenLocation.lng !== undefined &&
            Number(L.lat) === Number(chosenLocation.lat) && Number(L.lng) === Number(chosenLocation.lng)) {
          locationSelect.selectedIndex = i;
          showLocationMeta(L);
          break;
        }
      } catch (e) {}
    }
  }
}

// load location options (tries with auth then fallback)
async function loadLocationOptions() {
  if (!locationSelect) return;
  const userId = localStorage.getItem('userId') || '';
  const qs = userId ? ('?userId=' + encodeURIComponent(userId)) : '';
  const url = API_BASE + '/api/location/options' + qs;

  async function doFetch(withAuth) {
    const headers = {};
    if (withAuth && token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(url, { method: 'GET', headers });
      const text = await res.text().catch(() => '');
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch (e) {}
      return { ok: res.ok, status: res.status, text, json };
    } catch (err) {
      return { ok: false, status: 0, text: '', json: null, error: err };
    }
  }

  const primary = await doFetch(true);
  if (primary.ok) {
    const options = Array.isArray(primary.json.locationOptions) ? primary.json.locationOptions : [];
    const chosen = primary.json.chosenLocation || null;
    populateLocationSelect(options, chosen);
    return;
  }
  const fallback = await doFetch(false);
  if (fallback.ok) {
    const options = Array.isArray(fallback.json.locationOptions) ? fallback.json.locationOptions : [];
    const chosen = fallback.json.chosenLocation || null;
    populateLocationSelect(options, chosen);
    console.warn('Options loaded without Authorization header — check backend auth rules.');
    return;
  }

  const debugMessage = primary.text || fallback.text || (primary.error ? String(primary.error) : `HTTP ${primary.status} / HTTP ${fallback.status}`);
  if (!userId) {
    locationSelect.innerHTML = '';
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Error: missing userId in localStorage (please login again)';
    locationSelect.appendChild(o);
    console.error('loadLocationOptions failed: no userId in localStorage and server response:', debugMessage);
    return;
  }
  locationSelect.innerHTML = '';
  const o = document.createElement('option');
  o.value = '';
  o.textContent = `Error loading locations: ${debugMessage.substring(0, 120)}${debugMessage.length>120?'...':''}`;
  locationSelect.appendChild(o);
  console.error('Failed to load location options (both attempts). Server said:', debugMessage);
}

async function saveChosenLocation(locObj) {
  if (!locObj) return;
  try {
    const url = API_BASE + '/api/location/choice' + (localStorage.getItem('userId') ? ('?userId=' + encodeURIComponent(localStorage.getItem('userId'))) : '');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` },
      body: JSON.stringify({ choice: locObj })
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json && json.success) {
      console.log('chosenLocation saved', json.chosenLocation || locObj);
    } else {
      console.warn('Could not save chosenLocation', res.status, json);
    }
  } catch (err) {
    console.error('saveChosenLocation error', err);
  }
}

if (locationSelect) {
  locationSelect.addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (!opt || !opt.dataset.loc || opt.value === '') { showLocationMeta(null); return; }
    let loc;
    try { loc = JSON.parse(opt.dataset.loc); } catch (err) { console.error('Failed to parse selected loc', err); showLocationMeta(null); return; }
    showLocationMeta(loc);
    saveChosenLocation(loc);
    if (loc.lat !== null && loc.lng !== null) { map.setView([loc.lat, loc.lng], 12); }
  });
}
loadLocationOptions();

// ----------------- ANALYSIS (call backend) -----------------
analyzeBtn.addEventListener("click", async () => {
  const roofArea = window.selectedRoofArea || 0;
  if (!roofArea || roofArea <= 0) {
    alert("Please draw your roof polygon on the map first!");
    return;
  }

  analysisResult.classList.remove("hidden");
  analysisResult.innerHTML = `<p class="text-lg text-gray-500">🔄 Running analysis...</p>`;

  // get coords: prefer dropdown selection, else polygon centroid
  let lat = NaN, lng = NaN;
  if (locationSelect && locationSelect.selectedOptions.length > 0) {
    const opt = locationSelect.selectedOptions[0];
    if (opt && opt.dataset && opt.dataset.loc && opt.value !== '') {
      try {
        const loc = JSON.parse(opt.dataset.loc);
        lat = Number(loc.lat); lng = Number(loc.lng);
      } catch (err) { console.warn("Could not parse dataset.loc", err); }
    }
  }
  if ((isNaN(lat) || isNaN(lng)) && drawnItems.getLayers().length > 0) {
    try {
      const layer = drawnItems.getLayers()[0];
      if (layer && typeof layer.getBounds === "function") {
        const c = layer.getBounds().getCenter();
        lat = Number(c.lat); lng = Number(c.lng);
      } else if (layer && typeof layer.getLatLngs === "function") {
        const latlngs = layer.getLatLngs()[0] || [];
        if (latlngs && latlngs.length) {
          const coords = latlngs.map(p => [p.lng, p.lat]);
          if (coords.length && (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1])) coords.push(coords[0]);
          if (window.turf) {
            const poly = turf.polygon([coords]); const c = turf.centroid(poly);
            lat = c?.geometry?.coordinates?.[1]; lng = c?.geometry?.coordinates?.[0];
          } else {
            const avg = coords.reduce((acc, cur) => [acc[0]+cur[0], acc[1]+cur[1]], [0,0]).map(v=>v/coords.length);
            lng = avg[0]; lat = avg[1];
          }
        }
      }
    } catch (err) { console.warn("Could not determine polygon center", err); }
  }

  // required inputs
  const dwellers = (() => {
    const v = document.getElementById("dwellersInput")?.value ?? '';
    return v.toString().trim() === '' ? NaN : Number(v);
  })();

  const roofTypeEl = document.getElementById("roofTypeInput") || document.getElementById("roofType");
  const roofType = (roofTypeEl && roofTypeEl.value) ? roofTypeEl.value : null;

  // floors from UI (must be integer >=0)
  let floors = NaN;
  const floorsEl = document.getElementById("floors");
  if (floorsEl) {
    const fRaw = (floorsEl.value ?? '').toString().trim();
    const parsed = fRaw === '' ? NaN : Number(fRaw);
    if (!isNaN(parsed) && parsed >= 0) floors = Math.floor(parsed);
  }

  // soil from UI if present
  const soilEl = document.getElementById("soilType");
  const soilType = soilEl ? (soilEl.value || null) : null;

  // validation (backend expects lat, lng, roofArea, roofType, dwellers, floors)
  if (isNaN(lat) || isNaN(lng) || isNaN(roofArea) || !roofType || isNaN(dwellers) || isNaN(floors)) {
    analysisResult.innerHTML = `<p class="text-red-600">❌ Missing or invalid fields. Required: lat, lng, roofArea, roofType, dwellers, floors</p>`;
    console.warn("Missing inputs for /api/calc", { lat, lng, roofArea, roofType, dwellers, floors });
    return;
  }

  // build payload
  const payload = { lat, lng, roofArea, roofType, dwellers, floors, avgFloorHeight: DEFAULTS.avgFloorHeight, velocity_m_s: DEFAULTS.velocity_m_s, wetMonths: DEFAULTS.wetMonths, safetyFactorFilter: DEFAULTS.safetyFactorFilter, pit_cost_per_m3: DEFAULTS.pit_cost_per_m3 };
  if (soilType) payload.soilType = soilType;

  try {
    const res = await fetch(API_BASE + '/api/calc', {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.success) {
      const msg = (data && data.message) ? data.message : `Server error (${res.status})`;
      analysisResult.innerHTML = `<p class="text-red-600">❌ ${msg}</p>`;
      console.error("Calculation failed", res.status, data);
      return;
    }

    // normalize server response
    const litersPerYear = data.runoff_liters_per_year ?? data.litersPerYear ?? data.runoff ?? 0;
    const estimatedCost = data.costs?.total_estimated_installation_cost ?? data.estimatedCost ?? data.cost ?? 0;
    const suffMonths = data.sufficiencyMonths ?? data.sufficiency_months ?? data.sufficiency ?? null;
    const suggestionServer = data.suggestion ?? data.recommendation ?? null;
    const coverageRatio = data.coverageRatio ?? null;

    // determine UI suggestion: storage tank + pit if harvest >= annual need, else pit + supplements
    const ANNUAL_NEED_PER_PERSON_LPD = 85;
    const annualNeed = Math.round((dwellers || 0) * ANNUAL_NEED_PER_PERSON_LPD * 365);
    let suggestionUI;
    if (Number(litersPerYear) >= Number(annualNeed) && annualNeed > 0) {
      suggestionUI = "Build Storage Tank + Recharge Pit";
    } else {
      suggestionUI = "Consider Recharge Pit with supplemental sources";
    }

    // show summary (headline uses suggestionUI)
    analysisResult.innerHTML = `
      <p class="text-lg">Feasibility: 
        <span class="font-bold ${(coverageRatio !== null ? (coverageRatio >= 0.25) : (data.feasibility === true || data.feasibility === 'YES')) ? "text-green-600" : "text-red-600"}">
          ${(coverageRatio !== null ? ((coverageRatio >= 0.25) ? "YES" : "NO") : (data.feasibility === true || data.feasibility === 'YES' ? "YES" : "NO"))}
        </span>
      </p>
      <p class="mt-2">Estimated Harvesting Capacity: 
        <span class="font-bold">${Number(litersPerYear || 0).toLocaleString()} Liters/year</span>
      </p>
      <p class="mt-2">Estimated Cost: 
        <span class="font-bold text-yellow-700">₹${Number(estimatedCost || 0).toLocaleString()}</span>
      </p>
      <p class="mt-2">Water Sufficiency: 
        <span class="font-bold">${suffMonths !== null ? suffMonths : (coverageRatio ? Math.round(coverageRatio * 12) : "N/A")} months</span>
      </p>
      <p class="mt-2">Suggestion: 
        <span class="font-bold text-blue-600">${suggestionUI}</span>
      </p>
    `;

    // design card (summary + collapse details containing filter/pipe/pit)
    designCard.classList.remove("hidden");
    const filterName = data.filters?.chosen?.name || (Array.isArray(data.filters?.candidates) && data.filters.candidates[0]?.name) || "N/A";
    const pipeName = data.pipe?.chosen_option?.name || data.pipe?.chosen_option?.id || "N/A";
    const pitVol = data.pit?.pit_volume_m3 ?? "N/A";
    const aquiferType = data.aquifer?.type ?? "N/A";

    let designHtml = `
      <h3 class="text-xl font-semibold text-blue-600">Suggested Structure</h3>
      <p class="mt-2 text-gray-700">${suggestionUI}</p>
      <p class="mt-1 text-gray-700">Estimated Cost: ₹${Number(estimatedCost || 0).toLocaleString()}</p>
      <details class="mt-3 p-3 bg-white/30 rounded"><summary class="font-medium">Design details (click to expand)</summary>
        <ul class="mt-2 text-sm text-gray-800 text-left">
          <li><strong>Recommended filter:</strong> ${filterName}</li>
          <li><strong>Recommended pipe:</strong> ${pipeName}</li>
          <li><strong>Pit volume (m³):</strong> ${pitVol}</li>
          <li><strong>Aquifer:</strong> ${aquiferType}</li>
        </ul>
      </details>
    `;
    designCard.innerHTML = designHtml;

    // output card (summary + PDF + JSON)
    outputCard.classList.remove("hidden");
    outputCard.innerHTML = `
      <p class="text-lg font-medium">💧 You can save 
        <span class="font-bold text-green-700">${Number(litersPerYear || 0).toLocaleString()} Liters/year</span>
      </p>
      <p class="mt-2">📅 Covers 
        <span class="font-bold">${suffMonths !== null ? suffMonths : (coverageRatio ? Math.round(coverageRatio * 12) : "N/A")} months</span> of family needs</p>
      <p class="mt-2">🏙 Equivalent to water for 
        <span class="font-bold">${Math.round(Number(litersPerYear || 0) / 10000)}</span> households</p>
      <div class="mt-4 flex flex-col md:flex-row gap-3 justify-center">
        <button id="downloadReportBtn" class=" no-pdf bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition">
          Download Technical Report (PDF)
        </button>
        <button id="govtDocsBtn" class="no-pdf bg-yellow-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-yellow-700 transition">
          📑 Govt Documentation Checklist
        </button>
      </div>
      <div class="mt-4 text-left">
        <details><summary class="text-sm font-medium">Show full analysis JSON</summary>
          <pre class="text-xs bg-gray-100 p-2 rounded max-h-72 overflow-auto">${JSON.stringify(data, null, 2)}</pre>
        </details>
      </div>
    `;

    // wire PDF button (pass reportData with server)
    document.getElementById("downloadReportBtn").addEventListener("click", async () => {
      const reportData = {
        district: (locationSelect.selectedOptions[0] && locationSelect.selectedOptions[0].dataset.loc) ? JSON.parse(locationSelect.selectedOptions[0].dataset.loc).address : "",
        roofType,
        dwellers,
        floors,
        soilType,
        rainfall_mm: data.rainfall_mm ?? data.rainfall ?? null,
        litersPerYear,
        estimatedCost,
        sufficiencyMonths: suffMonths,
        suggestion: suggestionUI,
        server: data
      };
      await generatePDF(reportData);
    });

    document.getElementById("govtDocsBtn").addEventListener("click", () => {
      alert("Govt documentation checklist will be shown (you can convert this to a modal/pdf).");
    });

  } catch (err) {
    console.error(err);
    analysisResult.innerHTML = `<p class="text-red-600">❌ Error: Could not connect to server</p>`;
  }
});

// ----------------- PDF GENERATION (improved) -----------------
// generatePDF (clean) — removes the JSON appendix
async function generatePDF(reportData) {
  if (!window.jspdf) {
    alert("PDF generation requires jsPDF. Ensure jsPDF script is included.");
    console.error("jsPDF missing");
    return;
  }
  if (!window.html2canvas) {
    alert("html2canvas not loaded. Confirm html2canvas script is included.");
    console.error("html2canvas missing");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 36;
  const usableW = pageW - margin * 2;
  let y = 48;

  const fmt = (v) => (v === null || v === undefined) ? "N/A" : (typeof v === "number" ? v.toLocaleString() : String(v));
  const inr = (v) => (v === null || v === undefined) ? "N/A" : ("₹" + Math.round(Number(v) || 0).toLocaleString());
  const safe = (o, path, d = null) => {
    try {
      const parts = path.split('.');
      let cur = o;
      for (const p of parts) {
        if (cur == null) return d;
        cur = cur[p];
      }
      return cur == null ? d : cur;
    } catch (e) { return d; }
  };

  const server = reportData.server || {};
  const user = localStorage.getItem("userName") || "User";
  const district = reportData.district || safe(server, "inputs.address") || safe(server, "district") || "";
  const roofArea = safe(server, "inputs.roofArea", safe(server, "roofArea", window.selectedRoofArea || "N/A"));
  const roofType = reportData.roofType || safe(server, "inputs.roofType") || safe(server, "roofType");
  const dwellers = reportData.dwellers ?? safe(server, "inputs.dwellers") ?? safe(server, "dwellers");
  const floors = safe(server, "inputs.floors", reportData.floors ?? "N/A");
  const soilType = safe(server, "inputs.soilType") || reportData.soilType || "N/A";

  const rainfall_mm = reportData.rainfall_mm ?? safe(server, "rainfall_mm") ?? safe(server, "rainfall") ?? "N/A";
  const runoff_lpy = safe(server, "runoff_liters_per_year", safe(server, "litersPerYear", safe(server, "runoff", 0)));
  const infiltrated_lpy = safe(server, "infiltrated_liters_per_year", null);
  const annualNeed_L = safe(server, "annualNeed", Math.round((dwellers || 0) * 85 * 365));
  const coverageRatio = safe(server, "coverageRatio", (annualNeed_L && runoff_lpy) ? (runoff_lpy / annualNeed_L) : null);

  const pipe_diam_mm = safe(server, "pipe.calculated_diameter_mm", safe(server, "pipe.calculated_diameter_mm", safe(server, "pipe_diameter_mm", "N/A")));
  const chosenPipe = safe(server, "pipe.chosen_option", null);
  const filterChosen = safe(server, "filters.chosen", null);
  const filterCandidates = safe(server, "filters.candidates", []);
  const pit_vol_m3 = safe(server, "pit.pit_volume_m3", safe(server, "pit_volume_m3", "N/A"));
  const pit_cost = safe(server, "pit.pit_cost_estimate", safe(server, "pit_cost_estimate", null));

  const cost_pipe = safe(server, "costs.chosen_pipe_cost", null);
  const cost_filter = safe(server, "costs.chosen_filter_cost", null);
  const cost_pit = pit_cost ?? safe(server, "costs.pit_cost", null);
  const total_cost = safe(server, "costs.total_estimated_installation_cost", reportData.estimatedCost ?? null);

  const aquifer = safe(server, "aquifer.type", "N/A");
  const suggestion = reportData.suggestion || safe(server, "suggestion") || safe(server, "recommendation") || "N/A";
  const feasibility = safe(server, "feasibility", (safe(server, "coverageRatio") && safe(server, "coverageRatio") >= 0.25) ? true : null);

  // Header
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("JalRakshak — Technical Report", margin, y);
  y += 22;
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(`Prepared for: ${user}`, margin, y); y += 14;
  doc.text(`District: ${district || "N/A"}`, margin, y); y += 18;

  // Summary columns
  const col1x = margin;
  const col2x = margin + usableW / 2 + 10;
  const lineH = 14;
  doc.setFont("helvetica", "bold"); doc.text("Quick summary", col1x, y); y += 16;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);

  const left = [
    ["Roof area (m²)", fmt(roofArea)],
    ["Roof type", roofType || "N/A"],
    ["Floors", fmt(floors)],
    ["Soil", soilType || "N/A"],
    ["Dwellers", fmt(dwellers)]
  ];
  const right = [
    ["Annual rainfall (mm)", fmt(rainfall_mm)],
    ["Potential harvest (L/yr)", fmt(runoff_lpy)],
    ["Infiltrated (L/yr)", fmt(infiltrated_lpy)],
    ["Annual need (L/yr)", fmt(annualNeed_L)],
    ["Coverage ratio", coverageRatio != null ? (Number(coverageRatio) * 100).toFixed(1) + "%" : "N/A"]
  ];
  let rowY = y;
  for (let i=0;i<Math.max(left.length,right.length);i++){
    const L=left[i]; const R=right[i];
    if (L){ doc.text(`${L[0]}:`, col1x, rowY); doc.text(String(L[1]), col1x + 120, rowY); }
    if (R){ doc.text(`${R[0]}:`, col2x, rowY); doc.text(String(R[1]), col2x + 140, rowY); }
    rowY += lineH;
  }
  y = rowY + 8;

  // Design & components
  doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.text("Design & Components", margin, y); y += 16;
  doc.setFont("helvetica","normal"); doc.setFontSize(10);
  doc.text("Pipe diameter (mm):", margin, y); doc.text(String(pipe_diam_mm ?? "N/A"), margin + 160, y); y += lineH;
  if (chosenPipe) {
    const name = chosenPipe.name || chosenPipe.id || JSON.stringify(chosenPipe);
    const cost = inr(safe(chosenPipe, "total_cost", cost_pipe));
    doc.text("Chosen pipe:", margin, y); doc.text(name + " — " + cost, margin + 120, y); y += lineH;
  }
  if (filterChosen) {
    doc.text("Recommended filter:", margin, y); doc.text((filterChosen.name || filterChosen.id) + " — " + inr(filterChosen.total_cost), margin + 140, y); y += lineH;
  } else if (Array.isArray(filterCandidates) && filterCandidates.length) {
    doc.text("Filter candidates:", margin, y); y += lineH;
    const maxShow = 4;
    for (let i=0;i<Math.min(filterCandidates.length,maxShow);i++){
      const f=filterCandidates[i];
      doc.text(`• ${f.name || f.id} — units: ${fmt(f.units_required)} — cost: ${inr(f.total_cost)}`, margin + 10, y);
      y += lineH;
    }
  }

  doc.text("Pit volume (m³):", margin, y); doc.text(String(pit_vol_m3 ?? "N/A"), margin + 120, y); y += lineH;
  doc.text("Pit estimate (INR):", margin, y); doc.text(inr(pit_cost), margin + 120, y); y += lineH;

  doc.setFont("helvetica","bold"); doc.text("Cost breakdown", margin, y); y += 14;
  doc.setFont("helvetica","normal");
  doc.text("Pipe:", margin, y); doc.text(inr(cost_pipe), margin + 120, y); y += lineH;
  doc.text("Filter:", margin, y); doc.text(inr(cost_filter), margin + 120, y); y += lineH;
  doc.text("Pit / excavation:", margin, y); doc.text(inr(cost_pit), margin + 120, y); y += lineH;
  doc.setFont("helvetica","bold");
  doc.text("Total estimated installation cost:", margin, y); doc.text(inr(total_cost), margin + 240, y); y += lineH + 8;

  doc.setFont("helvetica","normal");
  doc.text("Aquifer classification:", margin, y); doc.text(String(aquifer || "N/A"), margin + 150, y); y += lineH;
  doc.text("Feasibility:", margin, y); doc.text(feasibility === true ? "YES" : (feasibility === false ? "NO" : (coverageRatio ? (coverageRatio >= 0.25 ? "YES" : "NO") : "N/A")), margin + 120, y); y += lineH + 8;

  doc.setFont("helvetica","bold"); doc.text("Recommendation:", margin, y); y += 14;
  doc.setFont("helvetica","normal"); doc.text((suggestion || "See details"), margin, y, { maxWidth: usableW }); y += 36;

  doc.setFont("helvetica","bold"); doc.text("Assumptions / model constants", margin, y); y += 14;
  doc.setFont("helvetica","normal");
  const assumptions = [
    ["Floor height (m)", safe(server, "inputs.avgFloorHeight", "3.0")],
    ["Velocity (m/s)", safe(server, "inputs.velocity_m_s", "2.5")],
    ["Wet months used", safe(server, "inputs.wetMonths", "4")],
    ["Filter safety factor", safe(server, "inputs.safetyFactorFilter", "0.8")],
    ["Pit cost (INR/m³)", safe(server, "inputs.pit_cost_per_m3", "800")]
  ];
  for (const a of assumptions) { doc.text(`${a[0]}: ${fmt(a[1])}`, margin, y); y += lineH; }
  y += 8;

  // try to insert map snapshot
  try {
    const mapEl = document.getElementById("map");
    if (mapEl) {
      const canvas = await html2canvas(mapEl, { scale: 1.2, useCORS: true, backgroundColor: null });
      const dataUrl = canvas.toDataURL("image/png");
      if (y + 200 > pageH - 120) { doc.addPage(); y = 48; }
      const imgW = usableW; const imgH = (canvas.height * imgW) / canvas.width;
      doc.addImage(dataUrl, "PNG", margin, y, imgW, Math.min(imgH, pageH - y - 120));
      y += Math.min(imgH, pageH - y - 120) + 12;
    }
  } catch (err) { console.warn("Map capture failed for PDF (continuing):", err); }

  // Footer and save
  const outNameSafe = (district || "report").replace(/[^\w\-]/g, "_");
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text(`Generated by JalRakshak 1.0 — ${new Date().toLocaleString()}`, margin, pageH - 28);

  try {
    doc.save(`JalRakshak_Report_${outNameSafe}.pdf`);
    console.log("PDF saved:", `JalRakshak_Report_${outNameSafe}.pdf`);
  } catch (err) {
    console.error("Failed to save PDF:", err);
    alert("PDF generation failed. See console for details.");
  }
}


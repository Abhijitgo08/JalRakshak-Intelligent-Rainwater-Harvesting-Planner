const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

// Load dataset
const dataPath = path.join(__dirname, "..", "data", "rainfall_data.json");
let rainfallData = [];

try {
  rainfallData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
} catch (err) {
  console.error("❌ Error loading rainfall dataset:", err);
}

// Helper function: normalize district names for matching
function normalizeName(name) {
  return name.toLowerCase().trim();
}

// Route: GET /api/rainfall/:district
router.get("/:district", (req, res) => {
  const query = normalizeName(req.params.district);

  const found = rainfallData.find(
    (item) => normalizeName(item.district) === query
  );

  if (found) {
    return res.json({
      success: true,
      district: found.district,
      state: found.state,
      rainfall_mm: found.rainfall_mm,
    });
  } else {
    return res
      .status(404)
      .json({ success: false, message: "District not found in dataset" });
  }
});

module.exports = router;

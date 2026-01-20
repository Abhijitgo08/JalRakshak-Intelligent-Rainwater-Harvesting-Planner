# JalRakshak 1.0 - Intelligent Rainwater Harvesting Planner [SIH-25]

**JalRakshak** is a comprehensive web-based tool designed to assist homeowners and planners in designing efficient rainwater harvesting systems. It combines geospatial data, historical rainfall patterns, and hydraulic engineering formulas to provide precise estimates for water potential, storage requirements, and installation costs.

## 🚀 Project Overview

The system allows users to interactively map their roof and ground areas on a satellite map. It then processes this data through a Node.js backend to calculate:
- **Total Annual Water Potential**: Based on 20-year historical rainfall averages.
- **System Design**: Pipe diameters (Manning's formula), filter selection, and recharge pit sizing.
- **Cost Estimation**: Real-time estimation of material and labor costs.
- **Feasibility Analysis**: Site suitability based on aquifer type, soil permeability, and water demand.

---

## 🏗️ Detailed System Architecture

This project implements a **Service-Oriented Architecture (SOA)** with a strict separation between the Presentation Layer (Frontend), the Business Logic Layer (Backend API), and External Data Services.

### 1. Architectural Layers

#### A. Presentation Layer (Frontend)
*   **Framework**: Vanilla JavaScript (ES6+), HTML5, CSS3 (Tailwind CSS).
*   **Modules**:
    *   **Map Manager**: Wraps `Leaflet.js` and `Leaflet-Draw`. Handles the rendering of satellite tiles and captures user interaction (polygon drawing). It converts drawn shapes into GeoJSON-like coordinate arrays (Lat/Lng) for the backend.
    *   **State Manager**: Maintains a local state of inputs (Roof Area, Ground Area, Dweller Count, etc.) to ensure data consistency before API submission.
    *   **Report Engine**: Uses `html2canvas` to rasterize the DOM (map view) and `jsPDF` to compile text data + images into a downloadable PDF technical report.
    *   **API Client**: A wrapper around the browser's `fetch` API that handles JWT authentication headers and error parsing.

#### B. Application Layer (Backend)
*   **Runtime**: Node.js with Express.js.
*   **Core Modules**:
    *   **`routes/calcRoutes.js` (The Simulation Engine)**: The heart of the application. It orchestrates the flow of data from input -> environmental lookup -> hydraulic simulation -> cost estimation -> response.
    *   **`routes/location.js` (Geospatial Resolver)**: Handles "Reverse Geocoding" with a twist. It searches for administrative boundaries (Taluka/Tehsil) to categorize the location for government scheme eligibility.
    *   **`middleware/auth.js`**: Intercepts requests to protected routes, verifies JWT tokens, and injects user context.
*   **Data Models (Mongoose)**:
    *   `User`: Stores profile, hashed passwords, and references to saved locations.
    *   `LocationSchema`: Stores saved analyses, including raw inputs (polygons) and calculated outputs (cost, potential) for future retrieval.

#### C. Data Layer
*   **Primary Database**: MongoDB (Document Store). Chosen for its flexibility in storing complex, nested JSON objects related to geospatial analysis and reports.
*   **Caching**: `node-cache` is implemented in the location resolver to store repeated queries to the Overpass API, significantly reducing latency for popular locations.

---

## 🔄 Data Architecture & Logic Flow

### 1. The Hydraulic Simulation Engine (`calcRoutes.js`)
This module executes a sequential pipeline for every simulation request:

1.  **Input Normalization**: Validates lat/lng and ensures area inputs are positive numbers.
2.  **Environmental Data Fetching**:
    *   Calls **Open-Meteo Archive API**.
    *   **Query**: `start_date=2000-01-01`, `end_date=2020-12-31`, `daily=precipitation_sum`.
    *   **Processing**: Aggregates 21 years of daily data to compute a stable **Mean Annual Rainfall ($mm$)**.
3.  **Runoff Calculation**:
    *   `Roof Runoff` = $Area_{roof} \times Rainfall \times C_{roof}$ (Where $C_{roof}$ is coefficient ~0.8-0.9).
    *   `Ground Runoff` = $Area_{ground} \times Rainfall \times C_{ground}$ (Where $C_{ground}$ is derived from user selected surfaces like Paved/Soil).
4.  **Hydraulic Pipe Sizing (Iterative Solver)**:
    *   **Goal**: Find smallest standard pipe diameter ($D$) that handles Peak Flow ($Q$).
    *   **Peak Flow ($Q$)**: Estimated using a rational method approximation based on roof area and peak intensity.
    *   **Velocity Check**: Uses **Manning’s Equation** to verify if the selected diameter maintains self-cleansing velocity ($>0.6 m/s$) and doesn't exceed scour velocity.
    *   **Formula**: $V = (1/n) \times R^{2/3} \times S^{1/2}$
5.  **Filter Selection Logic**:
    *   Database contains `FILTER_PRODUCTS` with `capacity_m2` ratings.
    *   Algorithm: `Required_Capacity` = $Area_{roof} \times SafetyFactor$ (Default 1.5).
    *   Selects the cheapest filter where `Filter_Capacity` > `Required_Capacity`.
6.  **Recharge Pit Sizing**:
    *   Estimates `Infiltration_Volume` = Total Runoff $\times$ Soil Permeability Index (Sandy: 0.8, Clay: 0.2).
    *   `Pit_Volume` = `Infiltration_Volume` / `Wet_Months` (Assumes pit empties periodically during monsoon).

### 2. The Geospatial Resolver (`location.js`)
This module handles the complexity of mapping a coordinate to a meaningful administrative region, which is crucial for determining local government subsidies.

*   **Algorithm**: "Expanding Probe Search"
    1.  **Initial Radius**: specific Lat/Lng with $R=10km$.
    2.  **Query**: Overpass API (OSM) for `admin_level=6` (Taluka/Tehsil) boundaries that *contain* the point.
    3.  **Failure Handling**: If no boundary is found (common in rural areas or near borders), the search radius doubles ($20km, 40km...$) until a configured limit is reached or a boundary is found.
    4.  **Optimization**: Uses an "8-Directional Probe" strategy to check neighboring points if the exact center returns no data, ensuring robustness.

---

## 📂 Directory Structure

```
SIH-25/
├── BACKEND/
│   ├── config/db.js          # MongoDB Connection Logic
│   ├── data/                 # Static JSONs (Rainfall fallbacks, Scheme details)
│   ├── middleware/           # Auth & Error Handling
│   ├── models/               # Mongoose Schemas (User, UserLocation)
│   ├── routes/
│   │   ├── calcRoutes.js     # [CRITICAL] Physics & Math Logic
│   │   ├── location.js       # [CRITICAL] Overpass API Integration
│   │   ├── rainfallRoutes.js # Fallback Data API
│   │   └── auth.js           # Login/Signup Controllers
│   ├── server.js             # App Entrance & CORS Setup
│   └── package.json          # Node Dependencies
│
└── FRONTEND/
    ├── dashboard.js          # Main Application Logic (Map + UI)
    ├── dashboard.html        # Main View
    ├── index.html            # Landing Page
    ├── auth.js               # Frontend Auth Handling
    └── assets/               # Static Resources
```

---

## 🛠️ Installation & Setup

### Prerequisites
*   **Node.js**: v18.0.0+ (Required for built-in `fetch` support).
*   **MongoDB**: Local instance or MongoDB Atlas Connection String.

### 1. Configuration
Create `.env` in `BACKEND/`:
```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/jalrakshak
JWT_SECRET=somesecretkey
# Optional:
DEBUG_LOCATION=true
LOCATION_CACHE_TTL=3600
```

### 2. Backend Setup
```bash
cd BACKEND
npm install
npm start
# Server runs on http://localhost:5000
```

### 3. Frontend Setup
The frontend is served statically by the backend Express server.
*   Open browser to: `http://localhost:5000`
*   No separate build process required for Vanilla JS.

---

## 📡 API Reference

### Core Calculation
`POST /api/calc`
*   **Payload**:
    ```json
    {
      "lat": 18.52, "lng": 73.85,
      "roofArea": 150, "roofType": "concrete",
      "dwellers": 4, "floors": 2,
      "includeGround": true,
      "groundArea": 50,
      "groundSurfaces": ["paved", "soil"]
    }
    ```
*   **Response**: Returns complex JSON with `runoff_liters`, `cost_estimates`, `pipe_diameter`, and `feasibility_boolean`.

### Location Context
`POST /api/location/candidates`
*   **Payload**: `{ "latitude": 18.52, "longitude": 73.85 }`
*   **Response**: Returns list of nearby Administrative Regions (Talukas/Districts).

---
*Developed for Smart India Hackathon 2025*

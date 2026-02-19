const express = require('express');
const axios = require('axios');
const router = express.Router();

const ORS_PROFILES = {
  running: 'https://api.openrouteservice.org/v2/directions/foot-walking',
  cycling: 'https://api.openrouteservice.org/v2/directions/cycling-road'
};

// Mode-specific configuration
const MODE_CONFIG = {
  running: {
    short:  { radiusMin: 1.0, radiusMax: 1.5, distMin: 4,  distMax: 6,  maxRoutes: 4, paceMinPerMile: 10 },
    medium: { radiusMin: 1.5, radiusMax: 2.2, distMin: 6,  distMax: 9,  maxRoutes: 3, paceMinPerMile: 10 },
    long:   { radiusMin: 2.5, radiusMax: 3.5, distMin: 9,  distMax: 15, maxRoutes: 2, paceMinPerMile: 10 }
  },
  cycling: {
    short:  { radiusMin: 4.0, radiusMax: 6.0,  distMin: 16, distMax: 25, maxRoutes: 4, paceMinPerMile: 3.5 },
    medium: { radiusMin: 6.5, radiusMax: 10.0, distMin: 26, distMax: 40, maxRoutes: 3, paceMinPerMile: 3.5 },
    long:   { radiusMin: 10.0, radiusMax: 17.0, distMin: 41, distMax: 70, maxRoutes: 2, paceMinPerMile: 3.5 }
  }
};

// Convert degrees to radians
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

// Move a lat/lng point by distance (miles) at a bearing (degrees)
function offsetPoint(lat, lng, distanceMiles, bearingDeg) {
  const R = 3958.8; // Earth radius in miles
  const d = distanceMiles / R;
  const brng = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );

  return [toDeg(lat2), toDeg(lng2)];
}

// Generate waypoints for a loop route at a given bearing and radius (4-point diamond)
function generateLoopWaypoints(startLat, startLng, bearingDeg, radiusMiles) {
  // Create a rough diamond/loop shape
  // Point B: out at the main bearing
  const B = offsetPoint(startLat, startLng, radiusMiles, bearingDeg);
  // Point C: offset perpendicular (bearing + 90)
  const C = offsetPoint(startLat, startLng, radiusMiles, (bearingDeg + 90) % 360);
  // Point D: offset at bearing + 180, shorter distance to close the loop
  const D = offsetPoint(startLat, startLng, radiusMiles * 0.5, (bearingDeg + 180) % 360);

  // ORS expects [lng, lat] coordinate order
  return [
    [startLng, startLat],  // Start
    [B[1], B[0]],          // B
    [C[1], C[0]],          // C
    [D[1], D[0]],          // D
    [startLng, startLat]   // Back to start
  ];
}

// Generate waypoints for long routes — 5-point pentagon for more mileage and variety
function generateLongLoopWaypoints(startLat, startLng, bearingDeg, radiusMiles) {
  // Point B: out at the main bearing
  const B = offsetPoint(startLat, startLng, radiusMiles, bearingDeg);
  // Point C: offset perpendicular (bearing + 90)
  const C = offsetPoint(startLat, startLng, radiusMiles, (bearingDeg + 90) % 360);
  // Point D: opposite side
  const D = offsetPoint(startLat, startLng, radiusMiles * 0.6, (bearingDeg + 180) % 360);
  // Point E: adds a 5th point at bearing+135 at 0.8x radius to create a rounder loop
  const E = offsetPoint(startLat, startLng, radiusMiles * 0.8, (bearingDeg + 135) % 360);

  // ORS expects [lng, lat] coordinate order
  return [
    [startLng, startLat],  // Start
    [B[1], B[0]],          // B
    [C[1], C[0]],          // C
    [E[1], E[0]],          // E (extra point for longer loop)
    [D[1], D[0]],          // D
    [startLng, startLat]   // Back to start
  ];
}

// Call OpenRouteService directions API
async function getRoute(waypoints, profileUrl, options = {}) {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    throw new Error('ORS_API_KEY not set in .env');
  }

  const body = { coordinates: waypoints };

  // Add quiet routing preference when requested (foot-walking only)
  if (options.quiet && profileUrl === ORS_PROFILES.running) {
    body.profile_params = { weightings: { quiet_factor: 0.8 } };
  }

  const response = await axios.post(profileUrl, body, {
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json'
    }
  });

  const route = response.data.routes[0];
  const summary = route.summary;

  // Decode the geometry (ORS returns encoded polyline)
  const geometry = decodePolyline(route.geometry);

  return {
    coordinates: geometry, // Array of [lat, lng] for Leaflet
    distanceMeters: summary.distance,
    distanceMiles: (summary.distance * 0.000621371).toFixed(2),
    elevationGainFt: summary.ascent ? (summary.ascent * 3.28084).toFixed(0) : null,
    durationSeconds: summary.duration,
    durationMinutes: Math.round(summary.duration / 60)
  };
}

// Decode Google-style encoded polyline (ORS default)
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;

  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// Calculate how much of a route overlaps with itself (out-and-back detection)
// Returns overlap distance in miles
function calculateOverlapScore(coordinates) {
  const OVERLAP_THRESHOLD_M = 30; // meters — points closer than this count as overlap
  const R = 6371000; // Earth radius in meters
  let overlapMeters = 0;

  for (let i = 0; i < coordinates.length; i++) {
    const [lat1, lng1] = coordinates[i];
    // Check against non-adjacent points (skip nearby indices to avoid self-matching)
    for (let j = i + 10; j < coordinates.length; j++) {
      const [lat2, lng2] = coordinates[j];
      // Quick Haversine distance
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
      const dist = 2 * R * Math.asin(Math.sqrt(a));

      if (dist < OVERLAP_THRESHOLD_M) {
        // Estimate segment length from i to i+1
        if (i + 1 < coordinates.length) {
          const [latN, lngN] = coordinates[i + 1];
          const dLat2 = (latN - lat1) * Math.PI / 180;
          const dLng2 = (lngN - lng1) * Math.PI / 180;
          const a2 = Math.sin(dLat2 / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(latN * Math.PI / 180) *
            Math.sin(dLng2 / 2) ** 2;
          overlapMeters += 2 * R * Math.asin(Math.sqrt(a2));
        }
        break; // Only count this point once
      }
    }
  }

  return overlapMeters * 0.000621371; // Convert to miles
}

// Estimate time based on pace
function estimateTime(distanceMiles, paceMinPerMile = 10) {
  return Math.round(parseFloat(distanceMiles) * paceMinPerMile);
}

// POST /api/routes/generate
router.post('/generate', async (req, res) => {
  const { lat, lng, exclude_bearings, mode, quiet } = req.body;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  const activeMode = (mode === 'cycling') ? 'cycling' : 'running';
  const config = MODE_CONFIG[activeMode];
  const profileUrl = ORS_PROFILES[activeMode];
  const routeOptions = { quiet: !!quiet };

  console.log(`Generating ${activeMode} routes from [${lat}, ${lng}]${quiet ? ' (quiet mode)' : ''}...`);

  let bearings = [0, 45, 90, 135, 180, 225, 270, 315];

  // Filter out bearings already shown (for "Generate More")
  if (exclude_bearings && Array.isArray(exclude_bearings) && exclude_bearings.length > 0) {
    bearings = bearings.filter(b => !exclude_bearings.includes(b));
    console.log(`Excluding bearings: ${exclude_bearings.join(', ')} → using: ${bearings.join(', ')}`);
  }

  const candidates = [];

  for (const bearing of bearings) {
    for (const [category, cfg] of Object.entries(config)) {
      candidates.push({
        bearing,
        radius: cfg.radiusMin + Math.random() * (cfg.radiusMax - cfg.radiusMin),
        category
      });
    }
  }

  const routes    = { short: [], medium: [], long: [] };
  const allRoutes = []; // Every successful route regardless of distance
  const errors    = [];

  // Process candidates with a small delay between API calls to avoid rate limiting
  for (const candidate of candidates) {
    try {
      const waypoints = candidate.category === 'long'
        ? generateLongLoopWaypoints(lat, lng, candidate.bearing, candidate.radius)
        : generateLoopWaypoints(lat, lng, candidate.bearing, candidate.radius);

      const route = await getRoute(waypoints, profileUrl, routeOptions);

      const dist = parseFloat(route.distanceMiles);
      const cfg = config[candidate.category];
      const estTime = estimateTime(route.distanceMiles, cfg.paceMinPerMile);
      const overlapMiles = parseFloat(calculateOverlapScore(route.coordinates).toFixed(2));

      console.log(`  ${getBearingLabel(candidate.bearing)} ${candidate.category}: ${dist} mi, overlap: ${overlapMiles} mi`);

      const routeRecord = {
        ...route,
        estimatedMinutes: estTime,
        bearing: candidate.bearing,
        bearingLabel: getBearingLabel(candidate.bearing),
        overlapMiles,
        dist  // numeric, used server-side for backfill sorting
      };

      allRoutes.push(routeRecord);

      // Primary: strict range match
      if (dist >= cfg.distMin && dist <= cfg.distMax) {
        routes[candidate.category].push(routeRecord);
      }

      // Small delay to be nice to ORS free tier
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      errors.push({
        bearing: candidate.bearing,
        category: candidate.category,
        error: err.response?.data?.error?.message || err.message
      });
    }
  }

  // Select best routes per category, then backfill to max from the full pool
  for (const [category, cfg] of Object.entries(config)) {
    routes[category] = selectBestRoutes(routes[category], cfg.maxRoutes);

    if (routes[category].length < cfg.maxRoutes) {
      const usedBearings = new Set(routes[category].map(r => r.bearing));
      const midpoint     = (cfg.distMin + cfg.distMax) / 2;

      // Pull from allRoutes: prefer unused bearings, routes closest in distance to the target midpoint.
      // Soft bounds: don't use routes shorter than 60% of distMin or longer than 160% of distMax.
      const fallbacks = allRoutes
        .filter(r =>
          !usedBearings.has(r.bearing) &&
          r.dist >= cfg.distMin * 0.6 &&
          r.dist <= cfg.distMax * 1.6
        )
        .sort((a, b) => Math.abs(a.dist - midpoint) - Math.abs(b.dist - midpoint));

      const needed = cfg.maxRoutes - routes[category].length;
      routes[category].push(...fallbacks.slice(0, needed));

      if (needed > 0 && fallbacks.length > 0) {
        console.log(`  Backfilled ${category}: added ${Math.min(needed, fallbacks.length)} routes from pool`);
      }
    }
  }

  console.log(`Generated ${routes.short.length} short, ${routes.medium.length} medium, ${routes.long.length} long ${activeMode} routes (${errors.length} errors)`);

  res.json({
    routes,
    mode: activeMode,
    distanceLabels: {
      short: `${config.short.distMin}–${config.short.distMax} mi`,
      medium: `${config.medium.distMin}–${config.medium.distMax} mi`,
      long: `${config.long.distMin}–${config.long.distMax} mi`
    },
    totalCandidates: candidates.length,
    errors: errors.length
  });
});

// Select best routes: prefer spread of bearings, penalize short out-and-backs
function selectBestRoutes(routeList, maxCount) {
  if (routeList.length <= maxCount) return routeList;

  // Penalize routes with significant overlap (< 2 mi overlap is bad — means out-and-back)
  // Sort by: low overlap first, then spread bearings
  routeList.sort((a, b) => {
    // Heavily penalize overlap under 2 miles (short out-and-backs are the worst)
    const overlapA = (a.overlapMiles || 0) > 0 && (a.overlapMiles || 0) < 2 ? 100 : (a.overlapMiles || 0);
    const overlapB = (b.overlapMiles || 0) > 0 && (b.overlapMiles || 0) < 2 ? 100 : (b.overlapMiles || 0);
    if (overlapA !== overlapB) return overlapA - overlapB;
    return a.bearing - b.bearing;
  });

  // Take top routes with bearing diversity
  const selected = [];
  const usedBearings = new Set();

  // First pass: pick one per bearing (best overlap score)
  for (const route of routeList) {
    if (selected.length >= maxCount) break;
    if (!usedBearings.has(route.bearing)) {
      selected.push(route);
      usedBearings.add(route.bearing);
    }
  }

  // Second pass: fill remaining slots
  for (const route of routeList) {
    if (selected.length >= maxCount) break;
    if (!selected.includes(route)) {
      selected.push(route);
    }
  }

  return selected;
}

function getBearingLabel(bearing) {
  const labels = {
    0: 'North', 45: 'Northeast', 90: 'East', 135: 'Southeast',
    180: 'South', 225: 'Southwest', 270: 'West', 315: 'Northwest'
  };
  return labels[bearing] || `${bearing}°`;
}

module.exports = router;

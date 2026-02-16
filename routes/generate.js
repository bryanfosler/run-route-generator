const express = require('express');
const axios = require('axios');
const router = express.Router();

const ORS_BASE = 'https://api.openrouteservice.org/v2/directions/foot-walking';

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

// Generate waypoints for a loop route at a given bearing and radius
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

// Call OpenRouteService directions API
async function getRoute(waypoints) {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    throw new Error('ORS_API_KEY not set in .env');
  }

  const response = await axios.post(ORS_BASE, {
    coordinates: waypoints,
    options: { avoid_features: ['highways'] }
  }, {
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

// Estimate pace (minutes per mile) — rough average for running
function estimateTime(distanceMiles) {
  const paceMinPerMile = 10; // 10 min/mile average
  return Math.round(parseFloat(distanceMiles) * paceMinPerMile);
}

// POST /api/routes/generate
router.post('/generate', async (req, res) => {
  const { lat, lng, exclude_bearings } = req.body;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  console.log(`Generating routes from [${lat}, ${lng}]...`);

  let bearings = [0, 45, 90, 135, 180, 225, 270, 315];

  // Filter out bearings already shown (for "Generate More")
  if (exclude_bearings && Array.isArray(exclude_bearings) && exclude_bearings.length > 0) {
    bearings = bearings.filter(b => !exclude_bearings.includes(b));
    console.log(`Excluding bearings: ${exclude_bearings.join(', ')} → using: ${bearings.join(', ')}`);
  }

  // Short routes: ~1.0–1.5 mi radius → targets 4-6 mi loops
  // Medium routes: ~1.5–2.2 mi radius → targets 6-9 mi loops
  const candidates = [];

  for (const bearing of bearings) {
    // One short candidate per bearing
    candidates.push({
      bearing,
      radius: 1.0 + Math.random() * 0.5, // 1.0-1.5 mi
      category: 'short'
    });
    // One medium candidate per bearing
    candidates.push({
      bearing,
      radius: 1.5 + Math.random() * 0.7, // 1.5-2.2 mi
      category: 'medium'
    });
  }

  const routes = { short: [], medium: [] };
  const errors = [];

  // Process candidates with a small delay between API calls to avoid rate limiting
  for (const candidate of candidates) {
    try {
      const waypoints = generateLoopWaypoints(lat, lng, candidate.bearing, candidate.radius);
      const route = await getRoute(waypoints);

      const dist = parseFloat(route.distanceMiles);
      const estTime = estimateTime(route.distanceMiles);
      const overlapMiles = parseFloat(calculateOverlapScore(route.coordinates).toFixed(2));

      console.log(`  ${getBearingLabel(candidate.bearing)} ${candidate.category}: ${dist} mi, overlap: ${overlapMiles} mi`);

      const routeData = {
        ...route,
        estimatedMinutes: estTime,
        bearing: candidate.bearing,
        bearingLabel: getBearingLabel(candidate.bearing),
        overlapMiles
      };

      // Categorize by actual distance
      if (dist >= 4 && dist <= 6) {
        routes.short.push(routeData);
      } else if (dist >= 6 && dist <= 9) {
        routes.medium.push(routeData);
      }
      // Routes outside these ranges are discarded

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

  // Keep best routes (up to 3 per category, prefer variety in bearing)
  routes.short = selectBestRoutes(routes.short, 3);
  routes.medium = selectBestRoutes(routes.medium, 3);

  console.log(`Generated ${routes.short.length} short, ${routes.medium.length} medium routes (${errors.length} errors)`);

  res.json({
    routes,
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

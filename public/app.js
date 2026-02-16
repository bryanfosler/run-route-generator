// --- State ---
let map;
let startMarker = null;
let startLatLng = null;
let routeLayers = [];     // Leaflet polyline layers
let decoratorLayers = []; // Leaflet polylineDecorator layers
let routeData = [];       // Route objects from API
let activeRouteIndex = null;
let selectedRoutes = new Set(); // For multi-select (shift+click)
let usedBearings = [];    // Track bearings already shown (for Generate More)

const ROUTE_COLORS = ['#fc4c02', '#3498db', '#2ecc71', '#e74c3c', '#9b59b6', '#f39c12'];

// --- Heatmap State ---
let heatLayer = null;
let heatmapVisible = false;
let cachedActivities = null;
let activeTypeFilters = new Set(); // Which activity types are selected

// --- Map Setup ---
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([43.0731, -89.4012], 13); // Madison, WI default

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  // Click to drop pin
  map.on('click', (e) => {
    setStartLocation(e.latlng.lat, e.latlng.lng);
  });
}

// --- Location ---
function setStartLocation(lat, lng) {
  startLatLng = { lat, lng };

  if (startMarker) {
    startMarker.setLatLng([lat, lng]);
  } else {
    startMarker = L.marker([lat, lng], {
      draggable: true,
      title: 'Start Location'
    }).addTo(map);

    startMarker.on('dragend', (e) => {
      const pos = e.target.getLatLng();
      setStartLocation(pos.lat, pos.lng);
    });
  }

  map.setView([lat, lng], 14);

  // Update UI
  document.getElementById('pin-info').textContent =
    `Pin: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  document.getElementById('btn-generate').disabled = false;

  // Clear old routes
  clearRoutes();
}

async function searchLocation() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const btn = document.querySelector('.btn-search');
  btn.textContent = '...';

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
      { headers: { 'User-Agent': 'RunRouteGenerator/1.0' } }
    );
    const data = await res.json();

    if (data.length > 0) {
      const { lat, lon, display_name } = data[0];
      setStartLocation(parseFloat(lat), parseFloat(lon));
      document.getElementById('search-input').value = display_name.split(',').slice(0, 2).join(',');
    } else {
      showError('Location not found. Try a more specific search.');
    }
  } catch (err) {
    showError('Search failed: ' + err.message);
  } finally {
    btn.textContent = 'Search';
  }
}

// --- Route Generation ---
async function generateRoutes() {
  if (!startLatLng) return;

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  clearRoutes();
  decoratorLayers = [];
  showLoading();

  try {
    const res = await fetch('/api/routes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: startLatLng.lat, lng: startLatLng.lng })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Route generation failed');
    }

    displayRoutes(data.routes);
  } catch (err) {
    showError('Route generation failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Routes';
  }
}

// --- Display Routes ---
function displayRoutes(routes) {
  const container = document.getElementById('routes-container');
  routeData = [];
  usedBearings = [];
  let colorIndex = 0;

  let html = '';

  // Short routes
  if (routes.short.length > 0) {
    html += '<h3>Short (4–6 mi)</h3>';
    routes.short.forEach((route) => {
      const idx = routeData.length;
      const color = ROUTE_COLORS[colorIndex % ROUTE_COLORS.length];
      routeData.push({ ...route, color });
      if (!usedBearings.includes(route.bearing)) usedBearings.push(route.bearing);
      html += routeCardHTML(route, idx, color);
      drawRoute(route.coordinates, color, idx);
      colorIndex++;
    });
  }

  // Medium routes
  if (routes.medium.length > 0) {
    html += '<h3>Medium (6–9 mi)</h3>';
    routes.medium.forEach((route) => {
      const idx = routeData.length;
      const color = ROUTE_COLORS[colorIndex % ROUTE_COLORS.length];
      routeData.push({ ...route, color });
      if (!usedBearings.includes(route.bearing)) usedBearings.push(route.bearing);
      html += routeCardHTML(route, idx, color);
      drawRoute(route.coordinates, color, idx);
      colorIndex++;
    });
  }

  if (routeData.length === 0) {
    html = '<div class="empty-state">No routes found in the target distance ranges. Try a different starting location.</div>';
  } else {
    html = '<p class="selection-hint">Click to focus a route. Shift+click to compare multiple. Click again to show all.</p>' + html;
  }

  container.innerHTML = html;

  // Add "Generate More" button if routes were found
  if (routeData.length > 0) {
    addGenerateMoreButton();
  }

  // Fit map to show all routes
  if (routeLayers.length > 0) {
    const group = L.featureGroup(routeLayers);
    map.fitBounds(group.getBounds().pad(0.1));
  }
}

function routeCardHTML(route, index, color) {
  const elev = route.elevationGainFt ? `${route.elevationGainFt} ft` : '—';
  const estTime = route.estimatedMinutes || route.durationMinutes;
  return `
    <div class="route-card" data-index="${index}" onclick="highlightRoute(${index}, event)">
      <div class="route-color-dot" style="background: ${color}"></div>
      <div class="route-card-info">
        <div class="route-card-title">${route.bearingLabel} Loop</div>
        <div class="route-card-stats">
          <span>${route.distanceMiles} mi</span>
          <span>${elev} elev</span>
          <span>~${estTime} min</span>
        </div>
      </div>
      <button class="btn-reverse" onclick="event.stopPropagation(); reverseRoute(${index})" title="Reverse direction">&#x21bb;</button>
    </div>
  `;
}

function drawRoute(coordinates, color, index) {
  const polyline = L.polyline(coordinates, {
    color: color,
    weight: 4,
    opacity: 0.7
  }).addTo(map);

  polyline.on('click', (e) => highlightRoute(index, e.originalEvent));
  routeLayers.push(polyline);

  // Add direction chevrons
  const decorator = L.polylineDecorator(polyline, {
    patterns: [{
      offset: '50px',
      repeat: '150px',
      symbol: L.Symbol.arrowHead({
        pixelSize: 10,
        polygon: false,
        pathOptions: { stroke: true, color: color, weight: 2, opacity: 0.8 }
      })
    }]
  }).addTo(map);

  decoratorLayers.push(decorator);
}

function highlightRoute(index, event) {
  const isShift = event && event.shiftKey;

  if (isShift) {
    // Multi-select: toggle this route in/out of selection
    if (selectedRoutes.has(index)) {
      selectedRoutes.delete(index);
    } else {
      selectedRoutes.add(index);
    }
  } else {
    // Single click: if clicking the only selected route, deselect (show all)
    if (selectedRoutes.size === 1 && selectedRoutes.has(index)) {
      selectedRoutes.clear();
    } else {
      selectedRoutes.clear();
      selectedRoutes.add(index);
    }
  }

  applyRouteStyles();
  activeRouteIndex = selectedRoutes.size > 0 ? index : null;
}

function applyRouteStyles() {
  const hasSelection = selectedRoutes.size > 0;

  routeLayers.forEach((layer, i) => {
    const isSelected = selectedRoutes.has(i);
    layer.setStyle({
      weight: hasSelection ? (isSelected ? 6 : 3) : 4,
      opacity: hasSelection ? (isSelected ? 1.0 : 0.2) : 0.7
    });
    if (isSelected) layer.bringToFront();
  });

  // Update decorator opacity to match
  decoratorLayers.forEach((dec, i) => {
    if (dec) {
      const isSelected = selectedRoutes.has(i);
      const opacity = hasSelection ? (isSelected ? 0.8 : 0.1) : 0.8;
      dec.setStyle({ opacity });
    }
  });

  // Update card active state
  document.querySelectorAll('.route-card').forEach((card, i) => {
    card.classList.toggle('active', selectedRoutes.has(i));
  });
}

function clearRoutes() {
  routeLayers.forEach(layer => map.removeLayer(layer));
  decoratorLayers.forEach(layer => map.removeLayer(layer));
  routeLayers = [];
  decoratorLayers = [];
  routeData = [];
  usedBearings = [];
  activeRouteIndex = null;
  selectedRoutes = new Set();
  document.getElementById('routes-container').innerHTML =
    '<div class="empty-state">Set a start location, then generate routes</div>';
}

// --- Reverse Route ---
function reverseRoute(index) {
  const route = routeData[index];
  if (!route) return;

  // Reverse coordinates
  route.coordinates = route.coordinates.slice().reverse();

  // Redraw polyline
  routeLayers[index].setLatLngs(route.coordinates);

  // Redraw decorator
  map.removeLayer(decoratorLayers[index]);
  const decorator = L.polylineDecorator(routeLayers[index], {
    patterns: [{
      offset: '50px',
      repeat: '150px',
      symbol: L.Symbol.arrowHead({
        pixelSize: 10,
        polygon: false,
        pathOptions: { stroke: true, color: route.color, weight: 2, opacity: 0.8 }
      })
    }]
  }).addTo(map);
  decoratorLayers[index] = decorator;
}

// --- Generate More ---
async function generateMoreRoutes() {
  if (!startLatLng) return;

  const btn = document.getElementById('btn-generate-more');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating...';
  }

  try {
    const res = await fetch('/api/routes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: startLatLng.lat,
        lng: startLatLng.lng,
        exclude_bearings: usedBearings
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Route generation failed');
    }

    appendRoutes(data.routes);
  } catch (err) {
    showError('Route generation failed: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Generate More';
    }
  }
}

function appendRoutes(routes) {
  const container = document.getElementById('routes-container');
  let colorIndex = routeData.length; // Continue color sequence

  // Remove existing "Generate More" button before appending
  const existingBtn = document.getElementById('btn-generate-more');
  if (existingBtn) existingBtn.remove();

  let html = '';
  const allNew = [...(routes.short || []), ...(routes.medium || [])];

  if (allNew.length === 0) {
    showError('No additional routes found. All directions have been explored.');
    return;
  }

  // Short routes
  if (routes.short && routes.short.length > 0) {
    html += '<h3>More Short (4–6 mi)</h3>';
    routes.short.forEach((route) => {
      const idx = routeData.length;
      const color = ROUTE_COLORS[colorIndex % ROUTE_COLORS.length];
      routeData.push({ ...route, color });
      if (!usedBearings.includes(route.bearing)) usedBearings.push(route.bearing);
      html += routeCardHTML(route, idx, color);
      drawRoute(route.coordinates, color, idx);
      colorIndex++;
    });
  }

  // Medium routes
  if (routes.medium && routes.medium.length > 0) {
    html += '<h3>More Medium (6–9 mi)</h3>';
    routes.medium.forEach((route) => {
      const idx = routeData.length;
      const color = ROUTE_COLORS[colorIndex % ROUTE_COLORS.length];
      routeData.push({ ...route, color });
      if (!usedBearings.includes(route.bearing)) usedBearings.push(route.bearing);
      html += routeCardHTML(route, idx, color);
      drawRoute(route.coordinates, color, idx);
      colorIndex++;
    });
  }

  // Append new cards + Generate More button
  container.insertAdjacentHTML('beforeend', html);
  addGenerateMoreButton();

  // Fit map to show all routes
  if (routeLayers.length > 0) {
    const group = L.featureGroup(routeLayers);
    map.fitBounds(group.getBounds().pad(0.1));
  }
}

function addGenerateMoreButton() {
  const container = document.getElementById('routes-container');
  // Only show if there are still unused bearings
  if (usedBearings.length < 8) {
    const remaining = 8 - usedBearings.length;
    container.insertAdjacentHTML('beforeend', `
      <button id="btn-generate-more" class="btn btn-generate-more" onclick="generateMoreRoutes()">
        Generate More (${remaining} directions left)
      </button>
    `);
  }
}

// --- UI Helpers ---
function showLoading() {
  document.getElementById('routes-container').innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <div>Generating routes...</div>
      <div style="font-size: 0.75rem; color: #666; margin-top: 0.5rem;">This may take 15-30 seconds</div>
    </div>
  `;
}

function showError(msg) {
  const container = document.getElementById('routes-container');
  // Append error without clearing existing content
  const div = document.createElement('div');
  div.className = 'error-msg';
  div.textContent = msg;
  container.appendChild(div);
}

// --- Heatmap ---
function decodePolylineClient(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

async function toggleHeatmap() {
  const btn = document.getElementById('btn-heatmap-toggle');
  const filters = document.getElementById('heatmap-filters');
  const status = document.getElementById('heatmap-status');

  if (heatmapVisible) {
    // Hide
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    heatmapVisible = false;
    btn.textContent = 'Show Heatmap';
    btn.classList.remove('active');
    filters.style.display = 'none';
    status.textContent = '';
    return;
  }

  // Show — fetch if needed
  btn.disabled = true;
  btn.textContent = 'Loading...';
  status.textContent = 'Fetching activities...';

  if (!cachedActivities) {
    try {
      const res = await fetch('/api/strava/activities');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch');
      cachedActivities = data.activities;
    } catch (err) {
      status.textContent = 'Failed to load activities: ' + err.message;
      btn.disabled = false;
      btn.textContent = 'Show Heatmap';
      return;
    }
  }

  heatmapVisible = true;
  btn.textContent = 'Hide Heatmap';
  btn.classList.add('active');
  btn.disabled = false;

  // Build filter chips from activity types
  buildFilterChips();
  filters.style.display = 'flex';

  // Render heatmap
  renderHeatmap();
}

function buildFilterChips() {
  const container = document.getElementById('heatmap-filters');
  const types = [...new Set(cachedActivities.map(a => a.type))].sort();

  // If no filters selected yet, select all
  if (activeTypeFilters.size === 0) {
    types.forEach(t => activeTypeFilters.add(t));
  }

  container.innerHTML = types.map(type => {
    const count = cachedActivities.filter(a => a.type === type).length;
    const active = activeTypeFilters.has(type) ? 'active' : '';
    return `<button class="filter-chip ${active}" data-type="${type}" onclick="toggleTypeFilter('${type}')">${formatType(type)} (${count})</button>`;
  }).join('');
}

function formatType(type) {
  // Convert "VirtualRide" → "Virtual Ride", etc.
  return type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function toggleTypeFilter(type) {
  if (activeTypeFilters.has(type)) {
    activeTypeFilters.delete(type);
  } else {
    activeTypeFilters.add(type);
  }
  buildFilterChips();
  renderHeatmap();
}

function renderHeatmap() {
  // Remove existing layer
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

  const filtered = cachedActivities.filter(a => activeTypeFilters.has(a.type));
  const status = document.getElementById('heatmap-status');
  status.textContent = `${filtered.length} activities`;

  if (filtered.length === 0) return;

  // Decode all polylines into heat points
  const heatPoints = [];
  for (const activity of filtered) {
    const points = decodePolylineClient(activity.polyline);
    for (const [lat, lng] of points) {
      heatPoints.push([lat, lng, 0.5]); // intensity 0.5
    }
  }

  heatLayer = L.heatLayer(heatPoints, {
    radius: 12,
    blur: 15,
    maxZoom: 17,
    gradient: { 0.2: '#2b83ba', 0.4: '#abdda4', 0.6: '#ffffbf', 0.8: '#fdae61', 1.0: '#d7191c' }
  }).addTo(map);

  // Move heatmap below route layers
  if (heatLayer._canvas) {
    heatLayer._canvas.style.zIndex = '200';
  }
}

// --- Strava Status ---
async function checkStrava() {
  const el = document.getElementById('strava-bar');
  try {
    const res = await fetch('/auth/strava/status');
    const data = await res.json();

    if (data.connected) {
      el.className = 'strava-bar connected';
      el.innerHTML = `<span class="strava-dot"></span> Connected as ${data.athlete}`;
      document.getElementById('heatmap-section').style.display = 'block';
    } else {
      el.className = 'strava-bar disconnected';
      el.innerHTML = `<span class="strava-dot"></span> <a href="/auth/strava">Connect Strava</a>`;
    }
  } catch {
    el.className = 'strava-bar disconnected';
    el.innerHTML = `<span class="strava-dot"></span> <a href="/auth/strava">Connect Strava</a>`;
  }
}

// --- Search on Enter key ---
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  checkStrava();

  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchLocation();
  });
});

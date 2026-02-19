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
let activeMode = 'running'; // 'running' or 'cycling'
let distanceLabels = null;  // Dynamic labels from backend
let quietMode = false;      // Quiet streets preference

const ROUTE_COLORS = ['#fc4c02', '#3498db', '#2ecc71', '#e74c3c', '#9b59b6', '#f39c12', '#1abc9c', '#e67e22', '#3455db'];

// --- Heatmap State ---
let heatLayers = {};      // { type → L.heatLayer }
let heatmapVisible = false;
let cachedActivities = null;
let activeTypeFilters = new Set(); // Which activity types are selected

// Color gradients per activity type
const TYPE_GRADIENTS = {
  Run:         { 0.2: '#fdae61', 0.6: '#fc4c02', 1.0: '#d7191c' },
  TrailRun:    { 0.2: '#fdae61', 0.6: '#fc4c02', 1.0: '#d7191c' },
  Ride:        { 0.2: '#74add1', 0.6: '#2b83ba', 1.0: '#4575b4' },
  VirtualRide: { 0.2: '#74add1', 0.6: '#2b83ba', 1.0: '#4575b4' },
  Walk:        { 0.2: '#abdda4', 0.6: '#1a9641', 1.0: '#006837' },
  Hike:        { 0.2: '#abdda4', 0.6: '#1a9641', 1.0: '#006837' },
  Swim:        { 0.2: '#74add1', 0.6: '#2166ac', 1.0: '#084594' },
};

// Representative dot color for filter chips
const TYPE_DOT_COLORS = {
  Run:         '#fc4c02',
  TrailRun:    '#fc4c02',
  Ride:        '#2b83ba',
  VirtualRide: '#2b83ba',
  Walk:        '#1a9641',
  Hike:        '#1a9641',
  Swim:        '#2166ac',
};

function getTypeGradient(type) {
  return TYPE_GRADIENTS[type] || { 0.2: '#c2a5cf', 0.6: '#8073ac', 1.0: '#542788' };
}

function getTypeDotColor(type) {
  return TYPE_DOT_COLORS[type] || '#8073ac';
}

// --- Map Setup ---
function initMap() {
  map = L.map('map', {
    zoomControl: false,
    doubleClickZoom: false  // handled manually below
  }).setView([43.0731, -89.4012], 13); // Madison, WI default

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  // --- Click gestures: single = pin, double = zoom in, triple = zoom out ---
  // 250ms debounce lets us distinguish single from double/triple click
  const clickSeq   = { count: 0, timer: null, latlng: null };
  const dragZoom   = { watching: false, active: false, startY: 0, startZoom: 0 };
  let lastMouseupMs = 0;

  map.on('click', (e) => {
    if (dragZoom.active) return;
    clickSeq.latlng = e.latlng;
    clickSeq.count++;
    if (clickSeq.timer) clearTimeout(clickSeq.timer);
    clickSeq.timer = setTimeout(() => {
      const n  = clickSeq.count;
      const ll = clickSeq.latlng;
      clickSeq.count = 0;
      clickSeq.timer = null;
      if      (n === 1) setStartLocation(ll.lat, ll.lng);
      else if (n === 2) map.flyTo(ll, map.getZoom() + 1);
      else              map.flyTo(ll, map.getZoom() - 1);
    }, 250);
  });

  // --- Drag-zoom: double-click-hold + drag up (zoom in) / down (zoom out) ---
  const mapEl = document.getElementById('map');

  // capture=true so we see the mousedown before Leaflet does
  mapEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (Date.now() - lastMouseupMs < 300) {
      // Second press within 300ms — watch for a drag
      dragZoom.watching  = true;
      dragZoom.startY    = e.clientY;
      dragZoom.startZoom = map.getZoom();
      map.dragging.disable(); // prevent Leaflet from panning during drag-zoom
    }
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (dragZoom.watching && Math.abs(e.clientY - dragZoom.startY) > 4) {
      // Threshold crossed — commit to drag-zoom
      dragZoom.watching = false;
      dragZoom.active   = true;
      mapEl.classList.add('zoom-dragging');
      // Cancel any pending click so it doesn't place a pin
      if (clickSeq.timer) { clearTimeout(clickSeq.timer); clickSeq.count = 0; clickSeq.timer = null; }
    }
    if (dragZoom.active) {
      const dy   = dragZoom.startY - e.clientY;           // up = positive = zoom in
      const zoom = Math.max(1, Math.min(19, dragZoom.startZoom + dy / 100));
      map.setZoom(zoom, { animate: false });
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    lastMouseupMs = Date.now();
    const wasEngaged = dragZoom.watching || dragZoom.active;
    dragZoom.watching = false;
    dragZoom.active   = false;
    mapEl.classList.remove('zoom-dragging');
    if (wasEngaged) map.dragging.enable();
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
      { headers: { 'User-Agent': 'RouteGenerator/1.0' } }
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

function detectLocation() {
  if (!navigator.geolocation) {
    showError('Geolocation is not supported by your browser.');
    return;
  }

  const btn = document.querySelector('.btn-locate');
  btn.textContent = '...';
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStartLocation(pos.coords.latitude, pos.coords.longitude);
      btn.textContent = '◎';
      btn.disabled = false;
    },
    (err) => {
      const messages = {
        1: 'Location access denied. Allow location in your browser settings.',
        2: 'Location unavailable. Try searching instead.',
        3: 'Location request timed out. Try again.'
      };
      showError(messages[err.code] || 'Could not get location.');
      btn.textContent = '◎';
      btn.disabled = false;
    },
    { timeout: 10000, maximumAge: 60000 }
  );
}

// --- Mode Toggle ---
function setMode(mode) {
  activeMode = mode;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  // Clear existing routes when switching modes
  clearRoutes();
}

// --- Quiet Mode Toggle ---
function toggleQuiet() {
  quietMode = !quietMode;
  const btn = document.getElementById('btn-quiet');
  btn.classList.toggle('active', quietMode);
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
      body: JSON.stringify({ lat: startLatLng.lat, lng: startLatLng.lng, mode: activeMode, quiet: quietMode })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Route generation failed');
    }

    distanceLabels = data.distanceLabels;
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
    html += `<h3>Short (${distanceLabels?.short || '4–6 mi'})</h3>`;
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
    html += `<h3>Medium (${distanceLabels?.medium || '6–9 mi'})</h3>`;
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

  // Long routes
  if (routes.long && routes.long.length > 0) {
    html += `<h3>Long (${distanceLabels?.long || '10–15 mi'})</h3>`;
    routes.long.forEach((route) => {
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
  const name = `${route.bearingLabel} Loop`;
  return `
    <div class="route-card" data-index="${index}" onclick="highlightRoute(${index}, event)">
      <div class="route-color-dot" style="background: ${color}"></div>
      <div class="route-card-info">
        <div class="route-card-title">${name}</div>
        <div class="route-card-stats">
          <span>${route.distanceMiles} mi</span>
          <span>${elev} elev</span>
          <span>~${estTime} min</span>
        </div>
      </div>
      <button class="btn-icon" onclick="event.stopPropagation(); downloadGPX(${index})" title="Download GPX">&#x2193;</button>
      <button class="btn-reverse" onclick="event.stopPropagation(); reverseRoute(${index})" title="Reverse direction">&#x21bb;</button>
    </div>
  `;
}

function buildDecorator(polyline, color, opacity, pixelSize) {
  return L.polylineDecorator(polyline, {
    patterns: [{
      offset: '50px',
      repeat: '150px',
      symbol: L.Symbol.arrowHead({
        pixelSize: pixelSize,
        polygon: false,
        pathOptions: { stroke: true, color: color, weight: 2, opacity: opacity }
      })
    }]
  }).addTo(map);
}

function drawRoute(coordinates, color, index) {
  const polyline = L.polyline(coordinates, {
    color: color,
    weight: 4,
    opacity: 0.7
  }).addTo(map);

  polyline.on('click', (e) => highlightRoute(index, e.originalEvent));
  routeLayers.push(polyline);

  decoratorLayers.push(buildDecorator(polyline, color, 0.8, 10));
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

    // Redraw decorator — L.PolylineDecorator doesn't support setStyle,
    // so remove and rebuild with the correct opacity/size each time.
    if (decoratorLayers[i]) map.removeLayer(decoratorLayers[i]);
    const route = routeData[i];
    const arrowOpacity = hasSelection ? (isSelected ? 1.0 : 0.05) : 0.8;
    const arrowSize = hasSelection && isSelected ? 13 : 10;
    decoratorLayers[i] = buildDecorator(layer, route.color, arrowOpacity, arrowSize);
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
  const isSelected = selectedRoutes.has(index);
  const hasSelection = selectedRoutes.size > 0;
  const arrowOpacity = hasSelection ? (isSelected ? 1.0 : 0.05) : 0.8;
  const arrowSize = hasSelection && isSelected ? 13 : 10;
  decoratorLayers[index] = buildDecorator(routeLayers[index], route.color, arrowOpacity, arrowSize);
}

// --- GPX Export ---
function downloadGPX(index) {
  const route = routeData[index];
  if (!route) return;

  const name = `${route.bearingLabel} Loop ${route.distanceMiles}mi`;
  const trkpts = route.coordinates
    .map(([lat, lng]) => `      <trkpt lat="${lat}" lon="${lng}"></trkpt>`)
    .join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Run Route Generator" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
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
        exclude_bearings: usedBearings,
        mode: activeMode,
        quiet: quietMode
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
  const allNew = [...(routes.short || []), ...(routes.medium || []), ...(routes.long || [])];

  if (allNew.length === 0) {
    showError('No additional routes found. All directions have been explored.');
    return;
  }

  // Short routes
  if (routes.short && routes.short.length > 0) {
    html += `<h3>More Short (${distanceLabels?.short || '4–6 mi'})</h3>`;
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
    html += `<h3>More Medium (${distanceLabels?.medium || '6–9 mi'})</h3>`;
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

  // Long routes
  if (routes.long && routes.long.length > 0) {
    html += `<h3>More Long (${distanceLabels?.long || '10–15 mi'})</h3>`;
    routes.long.forEach((route) => {
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
    // Hide — remove all type layers
    Object.values(heatLayers).forEach(layer => map.removeLayer(layer));
    heatLayers = {};
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
    const dotColor = getTypeDotColor(type);
    return `<button class="filter-chip ${active}" data-type="${type}" onclick="toggleTypeFilter('${type}')"><span class="type-dot" style="background:${dotColor}"></span>${formatType(type)} (${count})</button>`;
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
  // Remove all existing heat layers
  Object.values(heatLayers).forEach(layer => map.removeLayer(layer));
  heatLayers = {};

  const types = [...activeTypeFilters];
  let totalCount = 0;

  for (const type of types) {
    const activities = cachedActivities.filter(a => a.type === type && activeTypeFilters.has(a.type));
    if (activities.length === 0) continue;

    const heatPoints = [];
    for (const activity of activities) {
      const points = decodePolylineClient(activity.polyline);
      for (const [lat, lng] of points) {
        heatPoints.push([lat, lng, 0.5]);
      }
    }

    heatLayers[type] = L.heatLayer(heatPoints, {
      radius: 12,
      blur: 15,
      maxZoom: 17,
      gradient: getTypeGradient(type)
    }).addTo(map);

    totalCount += activities.length;
  }

  const status = document.getElementById('heatmap-status');
  status.textContent = `${totalCount} activities`;
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

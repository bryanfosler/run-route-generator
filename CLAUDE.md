# Run Route Generator — Project Context

## What It Does
Generates loop running/cycling routes from a start pin using OpenRouteService (ORS). Overlays a Strava activity heatmap. Deployed on Render free tier.

**Live URL:** https://route-generator-4kka.onrender.com
**Repo:** bryanfosler/run-route-generator

---

## Key Architecture

```
server.js (Express, port 3000)
├── /auth/strava      → routes/strava-auth.js  (OAuth + token management)
├── /api/strava       → routes/strava-activities.js
├── /api/routes       → routes/generate.js     (ORS route generation)
└── /public           → static frontend (Leaflet map + vanilla JS)
```

## APIs Used
- **ORS foot-walking:** `https://api.openrouteservice.org/v2/directions/foot-walking`
- **ORS cycling-road:** `https://api.openrouteservice.org/v2/directions/cycling-road`
- **Strava OAuth:** `https://www.strava.com/oauth/token`
- ORS coordinates are `[lng, lat]` order (opposite of Leaflet's `[lat, lng]`)

## Route Categories
| Category | Radius     | Distance  | Max routes |
|----------|------------|-----------|------------|
| Short    | 1.0–1.5 mi | 4–6 mi    | 4          |
| Medium   | 1.5–2.2 mi | 6–9 mi    | 3          |
| Long     | 2.5–3.5 mi | 9–15 mi   | 2          |

**Always fill to max.** Backfill uses flat `allRoutes` pool sorted by distance-to-midpoint.

---

## Known Leaflet Gotchas

**`L.PolylineDecorator` has no `setStyle()`** — it extends `L.Layer`, not `L.Path`. Calling `dec.setStyle()` is a silent no-op. To update arrow appearance, remove and rebuild the decorator: `map.removeLayer(dec); dec = L.polylineDecorator(...)`.

**Double-click fires two `click` events** — Leaflet emits `click` for each click in a sequence. Use a 250ms debounce + count to distinguish single/double/triple clicks. See `initMap()` in `public/app.js`.

---

## Render Deployment Notes

Render free tier has an **ephemeral filesystem** — any files written at runtime (including `.strava-tokens.json`) are wiped on deploy/restart.

**Strava token workaround:** `getAccessToken()` in `strava-auth.js` bootstraps from env vars if the token file is missing. After OAuth, the server logs an `export STRAVA_*=...` block — copy those to Render's dashboard.

**Required env vars on Render:**
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_REDIRECT_URI` (must be `https://route-generator-4kka.onrender.com/auth/strava/callback`)
- `ORS_API_KEY`
- `STRAVA_ACCESS_TOKEN`
- `STRAVA_REFRESH_TOKEN`
- `STRAVA_EXPIRES_AT`
- `STRAVA_ATHLETE_NAME` (skips Strava API call on /status)

---

## Dev Commands
```bash
cd ~/Documents/Claude/Run-Route-Generator
npm start          # runs server.js on port 3000
```

`.env` file holds all secrets locally. Never commit it.

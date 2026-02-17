# Bryan Learns: Run Route Generator

*Last updated: 02.16.2026*

---

## What This Project Actually Is

A web app that generates loop running routes from any starting point. You drop a pin (or search an address), and it fans out in 8 compass directions to build candidate loops, then picks the best ones. It also connects to Strava to overlay a heatmap of your past activities — so you can see where you've already been and find new territory.

**Live at:** https://route-generator-4kka.onrender.com

---

## How the System Works (The Big Picture)

```
Browser (Leaflet map + sidebar)
    ↕ HTTP
Express server (server.js)
    ├── /auth/strava → OAuth flow with Strava
    ├── /api/strava/activities → Fetch activity history
    └── /api/routes/generate → Generate loop routes via ORS
                                    ↕ HTTP
                        OpenRouteService API (external)
```

Think of it like a restaurant: the browser is the dining room where you interact, Express is the kitchen that coordinates everything, and ORS/Strava are suppliers that provide the raw ingredients (route geometry, activity data).

---

## The Codebase — What Lives Where

| File | What It Does |
|------|-------------|
| `server.js` | Entry point. Wires up Express, serves static files, registers route handlers |
| `routes/generate.js` | Route generation brain — waypoint math, ORS API calls, overlap detection, route selection |
| `routes/strava-auth.js` | Strava OAuth flow — login, callback, token refresh, status check |
| `routes/strava-activities.js` | Fetches all Strava activities with polylines, caches in memory |
| `public/app.js` | All frontend logic — map, route display, heatmap, UI interactions |
| `public/index.html` | Page structure, CDN script tags |
| `public/style.css` | Dark theme styling for sidebar, cards, chips, buttons |
| `.env` | Secrets (API keys, Strava credentials) — never committed |
| `.env.example` | Template showing what env vars are needed |

---

## Key Technical Concepts

### 1. How Routes Get Generated (The Compass Method)

We don't just ask "give me a 5-mile loop." ORS needs specific waypoints. So we:

1. Pick a compass bearing (N, NE, E, SE, S, SW, W, NW)
2. Project waypoints outward in a diamond shape using the **Haversine formula** (the math for distances on a sphere)
3. Send those waypoints to ORS, which snaps them to real roads/trails and returns a walkable route
4. Check if the actual distance falls in our target range (4-6 mi short, 6-9 mi medium)

The clever bit: we generate **two candidates per bearing** (short radius and medium radius), then pick the best 3 per category. This gives variety without making 50 API calls.

### 2. Encoded Polylines — Google's Compression Trick

Both ORS and Strava return route geometry as "encoded polylines" — a string like `_p~iF~ps|U_ulLnnqC_mqNvxq`. This is Google's algorithm for compressing lat/lng arrays into a short string. The `decodePolyline()` function unpacks these back into coordinate arrays.

**Why it matters:** A route with 500 points would be huge as JSON. Encoded, it's maybe 200 characters. This matters a lot when you're fetching hundreds of Strava activities.

We have two copies of this decoder — one in Node (for ORS responses) and one in the browser (for Strava polylines). Same algorithm, different contexts.

### 3. OAuth 2.0 — The Strava Handshake

The Strava connection uses the "authorization code" OAuth flow:

1. We redirect you to Strava's login page
2. You approve access → Strava redirects back with a **code**
3. We exchange that code for an **access token** + **refresh token**
4. Access tokens expire (6 hours), so we auto-refresh using the refresh token

**The "aha" moment:** The redirect URI must match *exactly* between your app config and what Strava expects. We learned this the hard way — a mismatch gives a cryptic "Bad Request" error with no helpful message.

### 4. Leaflet Layers — Stacking Visuals

The map uses multiple layer types stacked on top of each other:
- **Tile layer** (bottom) — the actual map tiles from OpenStreetMap
- **Heat layer** — the Strava activity heatmap
- **Polyline layers** — the generated routes
- **Decorator layers** — the chevron arrows showing direction
- **Marker** — the start pin

Each layer can be added/removed independently. This is why the heatmap persists when you generate new routes.

### 5. Multi-Select with Shift+Click

The route selection model has three states:
- **No selection** → all routes shown equally (initial overlay view)
- **Single select** (click) → one route highlighted, others dimmed
- **Multi-select** (shift+click) → toggle routes in/out of a comparison set

Click an already-selected route to deselect and return to the "show all" view. This pattern is borrowed from how file managers work.

---

## Bugs We Hit and How We Fixed Them

### The Highway Avoidance Disaster
We added `avoid_features: ['highways']` to make routes avoid busy roads. Every single route silently failed. Turns out `highways` is only valid for **driving** profiles — foot-walking only supports `ferries`, `fords`, and `steps`. The ORS docs aren't super clear about this, and errors were caught silently.

**Lesson:** Always check what options an API actually supports for your specific profile/endpoint. Free-tier APIs often have different capabilities per profile.

### The Strava Redirect URI
Deploying to Render meant the callback URL changed from `localhost:3000` to `route-generator-4kka.onrender.com`. Strava's error message was just "Bad Request" with `redirect_uri: invalid`. Had to update it in two places: the Render env var AND the Strava API settings page.

**Lesson:** OAuth redirect URIs are one of the most common deployment gotchas. Always check both sides (your app config + the provider's dashboard).

---

## Deployment — How It's Hosted

**Platform:** Render.com (free tier)
- Auto-deploys on every push to `main`
- Spins down after 15 min idle (cold starts take ~30s)
- Environment variables set in dashboard (never in code)

**GitHub repo:** Connected to Render for auto-deploy. `gh` CLI used for repo creation.

---

## What Good Engineers Would Notice

1. **Separation of concerns** — Backend routes are split into focused files (auth, activities, generation). The frontend is a single file but uses clear section comments.

2. **Caching** — The Strava activities endpoint caches in memory for 10 minutes. Without this, every heatmap toggle would re-fetch your entire activity history.

3. **Graceful degradation** — If Strava isn't connected, the heatmap section is hidden entirely. If ORS errors on some bearings, we still show the routes that succeeded.

4. **Rate limiting awareness** — 200ms delays between ORS calls, 200ms between Strava pagination calls. Free APIs have limits and being a good citizen keeps them free.

5. **Token auto-refresh** — The Strava access token expires every 6 hours. Instead of making you re-login, we silently refresh it using the stored refresh token.

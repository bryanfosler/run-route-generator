# Decision Log — Run Route Generator

*Tracks what we decided, why, and what we learned along the way.*

---

## Session 1 — Initial Build (Pre 02.16.2026)

### Decisions Made

| Decision | Choice | Why | Alternatives Considered |
|----------|--------|-----|------------------------|
| Server framework | Express.js | Simple, well-documented, standard for Node web apps | Fastify, Koa |
| Routing API | OpenRouteService (ORS) | Free tier, foot-walking profile, returns elevation data | Google Directions (paid), Mapbox (more complex), OSRM (no elevation) |
| Map library | Leaflet | Lightweight, great plugin ecosystem, free | Mapbox GL JS (heavier, requires token), Google Maps (paid) |
| Route strategy | Compass bearings + diamond waypoints | Generates diverse loops without needing a specialized loop algorithm | Random waypoints (less predictable), graph-based (way more complex) |
| Distance categories | Short (4-6 mi) + Medium (6-9 mi) | Covers typical training run distances | Single range, three categories |
| Auth approach | Strava OAuth with local token file | Simple, no database needed | Session-based, database-backed tokens |
| Deployment | Render.com free tier | Zero cost, auto-deploy from GitHub, Node support | Railway, Fly.io, Heroku (no free tier anymore) |

---

## Session 2 — Route Enhancements + Heatmap (02.16.2026)

### Route Quality Improvements

| Decision | Choice | Why |
|----------|--------|-----|
| Out-and-back detection | Haversine check: 30m threshold, skip adjacent 10 points | Catches routes that double back on themselves without false positives from nearby parallel streets |
| Overlap penalization | Penalize overlaps < 2 mi, allow longer overlaps | Short out-and-backs feel bad to run. A long overlap (like a trail with a shared start/finish) is acceptable |
| Route selection algorithm | Bearing diversity first, then overlap score | Seeing routes in different directions is more valuable than slightly shorter routes |
| Highway avoidance | **Removed** — `avoid_features: ['highways']` invalid for foot-walking | ORS only supports `ferries`, `fords`, `steps` for pedestrian profiles. Broke all route generation. |

### UX Enhancements

| Decision | Choice | Why |
|----------|--------|-----|
| Direction indicators | Leaflet polylineDecorator with arrow heads every 150px | Shows which way the loop goes — important for planning hills, wind, etc. |
| Route selection model | Click = solo, Shift+click = multi-select, re-click = show all | Mirrors file manager conventions. Initial view shows all overlaid. |
| Reverse route | Button on each card, flips coordinates + redraws arrows | Sometimes you want to run a loop the other direction |
| Generate More | Sends `exclude_bearings` to skip already-explored directions | Appends without clearing — keeps your existing routes while finding new ones |

### Strava Heatmap

| Decision | Choice | Why |
|----------|--------|-----|
| Heatmap integration | Toggle layer on same map (not separate view) | Can see heatmap while generating routes — the whole point is finding new areas |
| Activity type filters | All types, dynamically generated from data | Future-proof — no hardcoded list, works with whatever Strava activity types you have |
| Heatmap library | leaflet.heat | Lightweight, works with Leaflet, simple API |
| Activity caching | In-memory, 10 min TTL | Don't re-fetch hundreds of activities on every toggle. Memory is fine for single-user app |
| Polyline decoding | Client-side for heatmap, server-side for ORS | Heatmap needs to decode on the client because we filter by type there. ORS decoding stays on server. |

### Deployment

| Decision | Choice | Why |
|----------|--------|-----|
| GitHub CLI (gh) | Installed via Homebrew | Automates repo creation and push from terminal |
| Repo visibility | Public | No secrets in code — all sensitive values are env vars on Render |

---

## Bugs & Fixes

| Date | Bug | Root Cause | Fix | Time to Fix |
|------|-----|-----------|-----|-------------|
| 02.16.2026 | All routes failing — "No routes found" | `avoid_features: ['highways']` invalid for foot-walking profile | Removed the option entirely | ~5 min |
| 02.16.2026 | Strava OAuth "Bad Request" on deployed site | Redirect URI mismatch — `localhost` vs Render URL | Updated env var on Render + callback domain in Strava settings | ~10 min |

---

## Open Questions / Future Decisions

- Should we add a "quiet routing" preference using ORS `profile_params.quiet`? (valid for foot-walking)
- Should the heatmap use different colors per activity type when multiple are selected?
- Do we need longer route categories (10-15 mi for long runs)?
- Should Strava tokens be stored differently for the deployed version? (filesystem won't persist across Render deploys)

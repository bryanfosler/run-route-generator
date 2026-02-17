# Key Learnings — 02.16.2026

*Concepts, patterns, and gotchas worth remembering.*

---

## Concept: APIs Have Profile-Specific Rules

**What happened:** We added `avoid_features: ['highways']` to our ORS foot-walking requests. It silently broke everything.

**The lesson:** REST APIs often have parameters that are only valid for certain "modes" or "profiles." ORS has different rules for driving vs walking vs cycling. The parameter existed, just not for our profile. Always check the API docs for your specific use case, not just the general parameter list.

**Pattern to remember:** When an API call starts failing and you recently added options, strip them back to the minimum working request and add options back one at a time.

---

## Concept: OAuth Redirect URI — The Deployment Gotcha

**What happened:** App worked locally, broke on Render. Strava said "Bad Request" with no helpful detail.

**The lesson:** OAuth redirect URIs must match **exactly** across three places:
1. Your app's environment variable (`STRAVA_REDIRECT_URI`)
2. What your code sends to the provider
3. What the provider has configured in their developer dashboard

Even `http` vs `https` or a trailing slash will break it. This is the #1 deployment gotcha for OAuth apps.

**Pattern to remember:** When deploying an OAuth app, make a checklist: update redirect URI env var, update provider's callback domain config, verify protocol (https for production).

---

## Concept: Encoded Polylines — Compact Geometry

**What it is:** Google's algorithm for compressing GPS coordinate arrays into short strings. Both ORS and Strava use it.

**Why it matters:** A 500-point route as JSON might be 20KB. Encoded, it's maybe 300 bytes. When you're fetching hundreds of Strava activities, this compression is the difference between a fast load and a timeout.

**The tricky part:** The encoding uses 5-decimal precision (divide by 1e5), and the coordinates are delta-encoded (each point is an offset from the previous one). You have to decode sequentially — can't just grab point #47.

---

## Concept: Layered Map Architecture

**What it is:** Leaflet (and most map libraries) treat everything as stackable layers. Each visual element is its own layer that can be added, removed, and styled independently.

**Why it's powerful:** The heatmap, route polylines, direction arrows, and markers all coexist without interfering. You can toggle the heatmap while keeping routes visible. You can highlight one route without removing others.

**Pattern to remember:** Think of map features as independent layers, not a single canvas. Design your data structures to match (separate arrays for `routeLayers`, `decoratorLayers`, `heatLayer`).

---

## Concept: Caching for API Politeness

**What we did:** 10-minute in-memory cache for Strava activities. 200ms delays between ORS API calls.

**Why:** Free APIs have rate limits. Strava allows 100 requests per 15 minutes. ORS free tier has daily quotas. Without caching, every heatmap toggle would re-fetch your entire activity history.

**Pattern to remember:** For any external API, ask: "What happens if the user triggers this action 10 times in a row?" If the answer involves 10 identical API calls, you need caching.

---

## Concept: Graceful Degradation

**What it looks like in practice:**
- Strava not connected? Heatmap section is hidden (not broken)
- Some ORS route requests fail? We show the ones that succeeded
- No routes in target range? We show a helpful message, not a crash

**Pattern to remember:** Every external dependency can fail. Design each feature to work (or at least fail gracefully) when its dependencies are unavailable. Use optional chaining (`?.`), null checks, and try/catch generously at system boundaries.

---

## Concept: State Management Without a Framework

**What we did:** Plain JavaScript variables (`routeData`, `selectedRoutes`, `cachedActivities`) instead of React/Vue state.

**Why it works here:** Single-page app with one user. No complex component trees. State is straightforward: arrays of routes, a Set of selected indices, cached API data.

**When it wouldn't work:** Multiple views, shared state between components, undo/redo, real-time collaboration. That's when frameworks earn their complexity.

**Pattern to remember:** Don't reach for a state management framework until plain variables become painful. For most single-page tools, they never do.

---

## Tool: GitHub CLI (gh)

**What it is:** GitHub's command-line tool. Creates repos, PRs, issues from the terminal.

**Why it's handy:** `gh repo create my-app --public --source=. --push` does in one command what would take 5 clicks on github.com plus manual `git remote add` + `git push`.

**Install:** `brew install gh` then `gh auth login`

---

## Tool: Render.com Free Tier

**What it is:** Cloud hosting that auto-deploys from GitHub pushes.

**Key behaviors:**
- Free tier spins down after 15 min idle → first request takes ~30s to wake up
- Environment variables set in dashboard, not in code
- Filesystem is ephemeral — files written at runtime (like `.strava-tokens.json`) don't persist across deploys

**Gotcha for this project:** Our Strava tokens are saved to a file. On Render, this file disappears on every deploy. Fine for now (just re-connect Strava), but a real app would use a database or external storage.

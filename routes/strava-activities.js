const express = require('express');
const axios = require('axios');
const { getAccessToken } = require('./strava-auth');
const router = express.Router();

// In-memory cache
let cachedActivities = null;
let cacheTimestamp = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// GET /api/strava/activities
router.get('/activities', async (req, res) => {
  const token = await getAccessToken();
  if (!token) {
    return res.status(401).json({ error: 'Not connected to Strava' });
  }

  // Return cached data if fresh
  if (cachedActivities && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    console.log(`Returning ${cachedActivities.length} cached activities`);
    return res.json({ activities: cachedActivities });
  }

  try {
    console.log('Fetching activities from Strava...');
    const allActivities = [];
    let page = 1;
    const perPage = 200;

    while (true) {
      const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: `Bearer ${token}` },
        params: { page, per_page: perPage }
      });

      const batch = response.data;
      if (!batch || batch.length === 0) break;

      for (const activity of batch) {
        // Only include activities with a map polyline
        if (activity.map && activity.map.summary_polyline) {
          allActivities.push({
            type: activity.type,
            sport_type: activity.sport_type,
            polyline: activity.map.summary_polyline,
            start_date: activity.start_date,
            name: activity.name,
            distance: activity.distance,
            moving_time: activity.moving_time
          });
        }
      }

      console.log(`  Page ${page}: ${batch.length} activities (${allActivities.length} with polylines)`);

      if (batch.length < perPage) break;
      page++;

      // Small delay between pages
      await new Promise(r => setTimeout(r, 200));
    }

    // Cache results
    cachedActivities = allActivities;
    cacheTimestamp = Date.now();

    // Summarize activity types
    const typeCounts = {};
    allActivities.forEach(a => {
      typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
    });
    console.log(`Fetched ${allActivities.length} activities:`, typeCounts);

    res.json({ activities: allActivities });
  } catch (err) {
    console.error('Failed to fetch activities:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

module.exports = router;

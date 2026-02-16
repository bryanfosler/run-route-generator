const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const TOKEN_FILE = path.join(__dirname, '..', '.strava-tokens.json');

// Step 1: Redirect user to Strava authorization page
router.get('/', (req, res) => {
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${process.env.STRAVA_REDIRECT_URI}&scope=read,activity:read_all&approval_prompt=auto`;
  res.redirect(authUrl);
});

// Step 2: Handle callback from Strava with authorization code
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`<h2>Strava authorization denied</h2><p>${error}</p><a href="/">Back to app</a>`);
  }

  try {
    // Exchange authorization code for access token
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });

    const { access_token, refresh_token, expires_at, athlete } = response.data;

    // Save tokens locally
    const tokenData = {
      access_token,
      refresh_token,
      expires_at,
      athlete_id: athlete.id,
      athlete_name: `${athlete.firstname} ${athlete.lastname}`,
      saved_at: new Date().toISOString()
    };

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
    console.log(`Strava connected for ${tokenData.athlete_name}`);

    res.send(`
      <h2>Strava Connected!</h2>
      <p>Welcome, ${athlete.firstname}! Your account is linked.</p>
      <p><a href="/">Back to Route Generator</a></p>
    `);
  } catch (err) {
    console.error('Strava auth error:', err.response?.data || err.message);
    res.status(500).send(`<h2>Authentication failed</h2><p>${err.message}</p><a href="/auth/strava">Try again</a>`);
  }
});

// Step 3: Get a valid access token (auto-refresh if expired)
async function getAccessToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return null;
  }

  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);

  // If token is still valid (with 5 min buffer), return it
  if (tokens.expires_at > now + 300) {
    return tokens.access_token;
  }

  // Token expired — refresh it
  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token
    });

    const { access_token, refresh_token, expires_at } = response.data;
    tokens.access_token = access_token;
    tokens.refresh_token = refresh_token;
    tokens.expires_at = expires_at;
    tokens.saved_at = new Date().toISOString();

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log('Strava token refreshed');
    return access_token;
  } catch (err) {
    console.error('Token refresh failed:', err.response?.data || err.message);
    return null;
  }
}

// Check connection status
router.get('/status', async (req, res) => {
  const token = await getAccessToken();
  if (!token) {
    return res.json({ connected: false });
  }

  try {
    const response = await axios.get('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json({
      connected: true,
      athlete: `${response.data.firstname} ${response.data.lastname}`,
      city: response.data.city,
      state: response.data.state
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

module.exports = router;
module.exports.getAccessToken = getAccessToken;

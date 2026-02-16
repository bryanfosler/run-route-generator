require('dotenv').config();
const express = require('express');
const stravaAuth = require('./routes/strava-auth');
const generateRoutes = require('./routes/generate');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Strava OAuth routes
app.use('/auth/strava', stravaAuth);

// Route generation
app.use('/api/routes', generateRoutes);

app.listen(PORT, () => {
  console.log(`Run Route Generator running at http://localhost:${PORT}`);
  console.log(`Connect Strava: http://localhost:${PORT}/auth/strava`);
});

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', generalApiLimiter);

const successfulSubmissionByIp = new Map();
const ONE_MINUTE_MS = 60 * 1000;

const parseNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getTimeFilterClause = (timeFilter) => {
  if (timeFilter === 'hour') {
    return "AND created_at >= NOW() - INTERVAL '1 hour'";
  }
  if (timeFilter === 'day') {
    return "AND created_at >= NOW() - INTERVAL '24 hours'";
  }
  return '';
};

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/api/readings', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const lastSuccessfulSubmission = successfulSubmissionByIp.get(ip);

  if (lastSuccessfulSubmission && now - lastSuccessfulSubmission < ONE_MINUTE_MS) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute before submitting again.',
    });
  }

  const latitude = parseNumber(req.body.latitude);
  const longitude = parseNumber(req.body.longitude);
  const decibel = parseNumber(req.body.decibel);

  if (latitude === null || longitude === null || decibel === null) {
    return res.status(400).json({
      error: 'latitude, longitude, and decibel are required numeric values.',
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO readings (decibel_level, location)
       VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326))
       RETURNING id`,
      [decibel, longitude, latitude]
    );

    successfulSubmissionByIp.set(ip, now);

    return res.status(201).json({
      status: 'success',
      id: result.rows[0].id,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to store reading:', error);
    return res.status(500).json({ error: 'Failed to store reading.' });
  }
});

app.get('/api/readings/heatmap', async (req, res) => {
  const lat = parseNumber(req.query.lat);
  const lng = parseNumber(req.query.lng);
  const radius = parseNumber(req.query.radius);
  const timeFilter = req.query.time_filter || 'all';

  if (lat === null || lng === null || radius === null || radius <= 0) {
    return res.status(400).json({
      error: 'lat and lng are required, and radius must be a positive number.',
    });
  }

  if (!['hour', 'day', 'all'].includes(timeFilter)) {
    return res.status(400).json({
      error: 'time_filter must be one of: hour, day, all.',
    });
  }

  try {
    const sql = `
      SELECT
        ST_Y(location) AS latitude,
        ST_X(location) AS longitude,
        decibel_level AS weight
      FROM readings
      WHERE ST_DWithin(
        location::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
      ${getTimeFilterClause(timeFilter)}
      ORDER BY created_at DESC
    `;

    const result = await pool.query(sql, [lng, lat, radius]);
    return res.status(200).json(result.rows);
  } catch (_error) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch heatmap readings:', _error);
    return res.status(500).json({ error: 'Failed to fetch heatmap readings.' });
  }
});

app.get('/api/readings/report', async (req, res) => {
  const minLng = parseNumber(req.query.minLng);
  const minLat = parseNumber(req.query.minLat);
  const maxLng = parseNumber(req.query.maxLng);
  const maxLat = parseNumber(req.query.maxLat);

  if ([minLng, minLat, maxLng, maxLat].some((value) => value === null)) {
    return res.status(400).json({
      error: 'minLng, minLat, maxLng, and maxLat are required query parameters.',
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         AVG(decibel_level) AS average_decibel,
         MAX(decibel_level) AS peak_decibel,
         COUNT(*)::INT AS reading_count
       FROM readings
       WHERE location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
         AND ST_Intersects(location, ST_MakeEnvelope($1, $2, $3, $4, 4326))`,
      [minLng, minLat, maxLng, maxLat]
    );

    const row = result.rows[0];
    return res.status(200).json({
      averageDecibel: row.average_decibel === null ? null : Number(row.average_decibel),
      peakDecibel: row.peak_decibel === null ? null : Number(row.peak_decibel),
      readingCount: row.reading_count,
    });
  } catch (_error) {
    // eslint-disable-next-line no-console
    console.error('Failed to generate area report:', _error);
    return res.status(500).json({ error: 'Failed to generate area report.' });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API server running on port ${port}`);
});

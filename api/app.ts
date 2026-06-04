import express, { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import dotenv from 'dotenv';

const { Pool } = pg;

dotenv.config();

export const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', generalApiLimiter);

export const successfulSubmissionByIp = new Map<string, number>();
const ONE_MINUTE_MS = 60 * 1000;

// Clean up expired IP timestamps periodically to prevent memory leaks
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamp] of successfulSubmissionByIp.entries()) {
    if (now - timestamp >= ONE_MINUTE_MS) {
      successfulSubmissionByIp.delete(ip);
    }
  }
}, 60 * 1000);

// Allow Node to exit even if interval is active, and expose for test teardown
if (typeof cleanupInterval.unref === 'function') {
  cleanupInterval.unref();
}
export { cleanupInterval };

export const parseNumber = (value: any): number | null => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean' || Array.isArray(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const getTimeFilterClause = (timeFilter: string): string => {
  if (timeFilter === 'hour') {
    return "AND created_at >= NOW() - INTERVAL '1 hour'";
  }
  if (timeFilter === 'day') {
    return "AND created_at >= NOW() - INTERVAL '24 hours'";
  }
  return '';
};

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

interface ReadingRequestBody {
  latitude?: any;
  longitude?: any;
  decibel?: any;
}

app.post('/api/readings', async (req: Request<{}, any, ReadingRequestBody>, res: Response) => {
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

interface HeatmapRequestQuery {
  lat?: string;
  lng?: string;
  radius?: string;
  time_filter?: string;
}

app.get('/api/readings/heatmap', async (req: Request<{}, any, any, HeatmapRequestQuery>, res: Response) => {
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

  const deltaLat = radius / 111000;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const deltaLng = radius / (111000 * cosLat);

  const minLng = lng - deltaLng;
  const minLat = lat - deltaLat;
  const maxLng = lng + deltaLng;
  const maxLat = lat + deltaLat;

  try {
    const sql = `
      SELECT
        ST_Y(location) AS latitude,
        ST_X(location) AS longitude,
        decibel_level AS weight
      FROM readings
      WHERE location && ST_MakeEnvelope($4, $5, $6, $7, 4326)
        AND ST_DWithin(
          location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
      ${getTimeFilterClause(timeFilter)}
      ORDER BY created_at DESC
    `;

    const result = await pool.query(sql, [lng, lat, radius, minLng, minLat, maxLng, maxLat]);
    return res.status(200).json(result.rows);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch heatmap readings:', error);
    return res.status(500).json({ error: 'Failed to fetch heatmap readings.' });
  }
});

interface ReportRequestQuery {
  minLng?: string;
  minLat?: string;
  maxLng?: string;
  maxLat?: string;
}

app.get('/api/readings/report', async (req: Request<{}, any, any, ReportRequestQuery>, res: Response) => {
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
      averageDecibel: row.average_decibel === null ? null : Number(Number(row.average_decibel).toFixed(1)),
      peakDecibel: row.peak_decibel === null ? null : Number(Number(row.peak_decibel).toFixed(1)),
      readingCount: row.reading_count,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to generate area report:', error);
    return res.status(500).json({ error: 'Failed to generate area report.' });
  }
});

import request from 'supertest';
import { app, pool, parseNumber, getTimeFilterClause, successfulSubmissionByIp, cleanupInterval } from './app.js';

describe('Unit Tests', () => {
  describe('parseNumber', () => {
    it('should parse valid numbers and numeric strings', () => {
      expect(parseNumber(42)).toBe(42);
      expect(parseNumber(3.1415)).toBe(3.1415);
      expect(parseNumber('100')).toBe(100);
      expect(parseNumber('-5.5')).toBe(-5.5);
    });

    it('should return null for non-numeric or invalid inputs', () => {
      expect(parseNumber(NaN)).toBeNull();
      expect(parseNumber('invalid')).toBeNull();
      expect(parseNumber(undefined)).toBeNull();
      expect(parseNumber(null)).toBeNull();
      expect(parseNumber({})).toBeNull();
    });
  });

  describe('getTimeFilterClause', () => {
    it('should return correct interval query clauses', () => {
      expect(getTimeFilterClause('hour')).toContain("created_at >= NOW() - INTERVAL '1 hour'");
      expect(getTimeFilterClause('day')).toContain("created_at >= NOW() - INTERVAL '24 hours'");
    });

    it('should return empty string for all or unknown filters', () => {
      expect(getTimeFilterClause('all')).toBe('');
      expect(getTimeFilterClause('unknown')).toBe('');
    });
  });
});

describe('Integration Tests', () => {
  beforeAll(async () => {
    // Clear readings table before starting integration runs
    await pool.query('DELETE FROM readings');
  });

  afterAll(async () => {
    // Teardown connections and intervals to allow Jest process to exit cleanly
    clearInterval(cleanupInterval);
    await pool.end();
  });

  describe('GET /health', () => {
    it('should return status ok and HTTP 200', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('POST /api/readings', () => {
    beforeEach(() => {
      successfulSubmissionByIp.clear();
    });

    it('should accept valid submissions and save to database', async () => {
      const payload = {
        latitude: 40.7128,
        longitude: -74.006,
        decibel: 75.2,
      };

      const res = await request(app)
        .post('/api/readings')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(typeof res.body.id).toBe('number');
    });

    it('should return 400 for missing or invalid parameters', async () => {
      const payload = {
        latitude: 'invalid-latitude',
        longitude: -74.006,
        decibel: 75.2,
      };

      const res = await request(app)
        .post('/api/readings')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('latitude, longitude, and decibel are required');
    });

    it('should enforce 1-minute rate limiting per IP', async () => {
      const payload = {
        latitude: 40.7128,
        longitude: -74.006,
        decibel: 75.2,
      };

      // First submission succeeds
      const firstRes = await request(app)
        .post('/api/readings')
        .set('X-Forwarded-For', '192.168.1.50')
        .send(payload);
      expect(firstRes.status).toBe(201);

      // Second immediate submission from same IP fails with 429
      const secondRes = await request(app)
        .post('/api/readings')
        .set('X-Forwarded-For', '192.168.1.50')
        .send(payload);
      expect(secondRes.status).toBe(429);
      expect(secondRes.body.error).toContain('Too many requests');
    });
  });

  describe('GET /api/readings/heatmap', () => {
    it('should return matched spatial readings in radial bounds', async () => {
      // Clear data and insert specific readings
      await pool.query('DELETE FROM readings');
      await pool.query(
        `INSERT INTO readings (decibel_level, location) VALUES
         (60.0, ST_SetSRID(ST_MakePoint(-74.0060, 40.7128), 4326)),
         (80.0, ST_SetSRID(ST_MakePoint(-74.0065, 40.7130), 4326))`
      );

      const res = await request(app)
        .get('/api/readings/heatmap')
        .query({
          lat: 40.7128,
          lng: -74.0060,
          radius: 500, // 500 meters
          time_filter: 'all',
        });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
      expect(Number(res.body[0].weight)).toBeDefined();
    });

    it('should return empty list if no coordinates fall within radius', async () => {
      await pool.query('DELETE FROM readings');
      await pool.query(
        `INSERT INTO readings (decibel_level, location) VALUES
         (60.0, ST_SetSRID(ST_MakePoint(-75.0000, 41.0000), 4326))`
      );

      const res = await request(app)
        .get('/api/readings/heatmap')
        .query({
          lat: 40.7128,
          lng: -74.0060,
          radius: 500, // 500 meters
        });

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(0);
    });
  });

  describe('GET /api/readings/report', () => {
    it('should return aggregated math statistics for a bounding box area', async () => {
      await pool.query('DELETE FROM readings');
      await pool.query(
        `INSERT INTO readings (decibel_level, location) VALUES
         (50.45, ST_SetSRID(ST_MakePoint(-74.0060, 40.7128), 4326)),
         (70.82, ST_SetSRID(ST_MakePoint(-74.0062, 40.7129), 4326))`
      );

      const res = await request(app)
        .get('/api/readings/report')
        .query({
          minLng: -74.010,
          minLat: 40.710,
          maxLng: -74.000,
          maxLat: 40.715,
        });

      expect(res.status).toBe(200);
      // Average of 50.45 and 70.82 is 60.635, which rounds to 60.6
      expect(res.body.averageDecibel).toBe(60.6);
      expect(res.body.peakDecibel).toBe(70.8);
      expect(res.body.readingCount).toBe(2);
    });
  });
});

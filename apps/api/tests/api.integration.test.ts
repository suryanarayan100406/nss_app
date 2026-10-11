import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

const integration = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!integration)('API/PostgreSQL integration', () => {
  it('reports database readiness without exposing connection details', async () => {
    const response = await request(app).get('/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, database: 'ready' });
    expect(JSON.stringify(response.body)).not.toContain('postgresql://');
  });

  it('keeps the public health contract available', async () => {
    const response = await request(app).get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});

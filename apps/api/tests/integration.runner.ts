import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const exec = promisify(execFile);
const repo = path.resolve(new URL('../../..', import.meta.url).pathname);
const data = '/tmp/omnirush/nss-integration-postgres';
const port = 55432;
const databaseUrl = `postgresql://nss:nss@127.0.0.1:${port}/nss?schema=public`;

async function main() {
  await fs.rm(data, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: data, user: 'nss', password: 'nss', port, persistent: false, authMethod: 'password', onLog: () => undefined, onError: (error) => console.error(error) });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('nss');
  try {
    await exec('npx', ['prisma', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { cwd: repo, env: { ...process.env, DATABASE_URL: databaseUrl } });
    await exec('npx', ['tsx', 'scripts/import-static.ts'], { cwd: path.join(repo, 'apps', 'api'), env: { ...process.env, DATABASE_URL: databaseUrl, SESSION_SECRET: 'integration-session-secret-which-is-long-enough', PUBLIC_ORIGIN: 'http://localhost:8080', MANAGE_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' } });
    process.env.DATABASE_URL = databaseUrl;
    process.env.SESSION_SECRET = 'integration-session-secret-which-is-long-enough';
    process.env.PUBLIC_ORIGIN = 'http://localhost:8080';
    process.env.MANAGE_ORIGIN = 'http://localhost:5173';
    process.env.NODE_ENV = 'test';
    const { app } = await import('../src/app.js');
    const health = await request(app).get('/api/v1/health');
    if (health.status !== 200 || health.body.ok !== true) throw new Error(`Health check failed: ${health.status}`);
    const ready = await request(app).get('/ready');
    if (ready.status !== 200 || ready.body.database !== 'ready') throw new Error(`Readiness check failed: ${ready.status}`);
    const csrfResponse = await request(app).get('/api/v1/auth/csrf');
    const csrf = csrfResponse.body.csrfToken;
    const invalid = await request(app).post('/api/v1/auth/register').set('X-CSRF-Token', csrf).set('Cookie', `nss_csrf=${csrf}`).send({ email: 'student@iiitnr.edu.in.example.com', displayName: 'Invalid', password: 'long-enough-password' });
    if (invalid.status !== 400) throw new Error(`Domain policy failed: ${invalid.status}`);
    const publicEvents = await request(app).get('/api/v1/public/events');
    if (publicEvents.status !== 200) throw new Error(`Public events failed: ${publicEvents.status}`);
    for (const route of ['/', '/team.html', '/event-walkathon.html']) {
      const rendered = await request(app).get(route);
      if (rendered.status !== 200 || !rendered.text.includes('<html')) throw new Error(`SSR public route failed: ${route} (${rendered.status})`);
    }
    const dynamic = await request(app).get('/event.html?slug=walkathon-26');
    if (dynamic.status !== 200 || !dynamic.text.includes('Walkathon')) throw new Error('Dynamic event route failed');
    console.log('PostgreSQL integration checks passed');
  } finally {
    const { disconnectDb } = await import('../src/db.js');
    await disconnectDb();
    await pg.stop();
    await fs.rm(data, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

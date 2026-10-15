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
    for (const route of ['/', '/team.html', '/event-walkathon.html', '/calendar.html', '/archives.html', '/archive.html']) {
      const rendered = await request(app).get(route);
      if (rendered.status !== 200 || !rendered.text.includes('<html')) throw new Error(`SSR public route failed: ${route} (${rendered.status})`);
    }
    const dynamic = await request(app).get('/event.html?slug=walkathon-26');
    if (dynamic.status !== 200 || !dynamic.text.includes('Walkathon')) throw new Error('Dynamic event route failed');
    const ics = await request(app).get('/api/v1/public/events/walkathon-26.ics');
    if (ics.status !== 200 || !ics.text.includes('BEGIN:VCALENDAR') || !ics.text.includes('BEGIN:VEVENT')) throw new Error('ICS route failed');
    const { prisma } = await import('../src/db.js');
    const { hashPassword, issueEmailToken } = await import('../src/auth.js');
    const mobileEmail = `mobile-${Date.now()}@iiitnr.edu.in`;
    const mobileUser = await prisma.user.create({ data: { email: mobileEmail, displayName: 'Mobile Test User', passwordHash: await hashPassword('integration-mobile-password'), emailVerifiedAt: new Date() } });
    const mobileLogin = await request(app).post('/api/v1/auth/mobile/login').send({ email: mobileEmail, password: 'integration-mobile-password' });
    if (mobileLogin.status !== 200 || !mobileLogin.body.accessToken || !mobileLogin.body.refreshToken) throw new Error(`Mobile login failed: ${mobileLogin.status}`);
    const mobileMe = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${mobileLogin.body.accessToken}`);
    if (mobileMe.status !== 200 || mobileMe.body.user?.id !== mobileUser.id) throw new Error('Mobile bearer authentication failed');
    const mobileRefresh = await request(app).post('/api/v1/auth/mobile/refresh').send({ refreshToken: mobileLogin.body.refreshToken });
    if (mobileRefresh.status !== 200 || !mobileRefresh.body.refreshToken) throw new Error('Mobile refresh failed');
    const reuse = await request(app).post('/api/v1/auth/mobile/refresh').send({ refreshToken: mobileLogin.body.refreshToken });
    if (reuse.status !== 401) throw new Error('Mobile refresh reuse was not revoked');

    const adminEmail = `admin-${Date.now()}@iiitnr.edu.in`;
    const adminPassword = 'integration-admin-password';
    const admin = await prisma.user.create({ data: { email: adminEmail, displayName: 'Integration Admin', passwordHash: await hashPassword(adminPassword), emailVerifiedAt: new Date(), role: 'ADMIN' } });
    const browser = request.agent(app);
    const adminCsrfResponse = await browser.get('/api/v1/auth/csrf');
    const adminCsrf = adminCsrfResponse.body.csrfToken;
    const adminLogin = await browser.post('/api/v1/auth/login').set('X-CSRF-Token', adminCsrf).send({ email: adminEmail, password: adminPassword });
    if (adminLogin.status !== 200 || adminLogin.body.user?.id !== admin.id) throw new Error(`Admin login failed: ${adminLogin.status}`);

    const published = await browser.post('/api/v1/admin/events').set('X-CSRF-Token', adminCsrf).send({
      title: 'Integration published event', slug: `integration-published-${Date.now()}`, summary: 'Published state check', description: 'An integration test event.', category: 'Test',
      startAt: new Date(Date.now() + 86_400_000).toISOString(), timezone: 'Asia/Kolkata', venue: 'Test venue', organizer: 'NSS', tags: [], socialUrls: [], status: 'PUBLISHED', visibility: 'PRIVATE',
    });
    if (published.status !== 201 || published.body.event?.visibility !== 'PUBLIC') throw new Error(`Published event visibility normalization failed: ${published.status}`);

    const scheduled = await browser.post('/api/v1/admin/events').set('X-CSRF-Token', adminCsrf).send({
      title: 'Integration scheduled event', slug: `integration-scheduled-${Date.now()}`, summary: 'Scheduled state check', description: 'A scheduled integration test event.', category: 'Test',
      startAt: new Date(Date.now() + 172_800_000).toISOString(), timezone: 'Asia/Kolkata', venue: 'Test venue', organizer: 'NSS', tags: [], socialUrls: [], status: 'DRAFT', visibility: 'PRIVATE',
    });
    if (scheduled.status !== 201) throw new Error(`Scheduled event creation failed: ${scheduled.status}`);
    const scheduledEventId = scheduled.body.event.id;
    const schedule = await browser.post(`/api/v1/admin/events/${scheduledEventId}/schedule`).set('X-CSRF-Token', adminCsrf).send({ runAt: new Date(Date.now() + 3_600_000).toISOString() });
    if (schedule.status !== 200) throw new Error(`Event scheduling failed: ${schedule.status}`);
    const jobs = await browser.get('/api/v1/admin/scheduled');
    const eventJob = jobs.body.items.find((job: { type: string; payload?: { eventId?: string } }) => job.type === 'EVENT_PUBLISH' && job.payload?.eventId === scheduledEventId);
    if (!eventJob) throw new Error('Scheduled event job was not persisted');
    const cancelled = await browser.post(`/api/v1/admin/scheduled/${eventJob.id}/cancel`).set('X-CSRF-Token', adminCsrf).send({});
    if (cancelled.status !== 200) throw new Error(`Scheduled job cancellation failed: ${cancelled.status}`);
    const eventList = await browser.get('/api/v1/admin/events?pageSize=100');
    const cancelledEvent = eventList.body.items.find((event: { id: string }) => event.id === scheduledEventId);
    if (!cancelledEvent || cancelledEvent.status !== 'DRAFT' || cancelledEvent.visibility !== 'PRIVATE') throw new Error('Cancelling a schedule did not restore a private draft');

    const verifyToken = await issueEmailToken(mobileUser.id, 'VERIFY_EMAIL', 1);
    const firstVerify = await browser.get(`/api/v1/auth/verify?token=${encodeURIComponent(verifyToken)}`);
    const secondVerify = await browser.get(`/api/v1/auth/verify?token=${encodeURIComponent(verifyToken)}`);
    if (firstVerify.status !== 302 || !String(firstVerify.headers.location).endsWith('/manage/login?verified=1') || secondVerify.status !== 400) throw new Error('Verification token was reusable or redirected to the wrong management route');
    console.log('PostgreSQL integration checks passed');
  } finally {
    const { disconnectDb } = await import('../src/db.js');
    await disconnectDb();
    await pg.stop();
    await fs.rm(data, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Prisma, type EventStatus, type Role } from '@prisma/client';
import { prisma } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { audit } from './audit.js';
import { ensureCsrfCookie, normalizeEmail, requireCsrf } from './security.js';
import { attachUser, consumeEmailToken, establishMobileSession, establishSession, hashPassword, issueEmailToken, publicUser, requireAuth, requireRole, requireVerified, revokeMobileSession, revokeSession, rotateMobileSession, validateRegistrationEmail, verifyPassword } from './auth.js';
import { loginSchema, eventSchema, moderationSchema, paginationSchema, photoRemovalSchema, registerSchema, tokenSchema } from './validation.js';
import { createPublicDerivative, hammingDistance, privatePath, processUpload, publicPath, removePrivateUpload, removePublicDerivative } from './media.js';
import { sendMail } from './mail.js';
import { decide as decidePublication, releasePhotos } from './publication.js';
import { mergeHomepageContent, parseHomepageContent } from './content-schema.js';

export const apiRouter: Router = express.Router();
apiRouter.use(attachUser);
apiRouter.use(ensureCsrfCookie);
apiRouter.use(requireCsrf);

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      const dir = path.join(config.PRIVATE_MEDIA_ROOT, 'tmp');
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`),
  }),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: config.MAX_UPLOAD_FILES },
});

const publicEventStatuses: EventStatus[] = ['PUBLISHED', 'ONGOING', 'COMPLETED', 'CANCELLED'];
const archiveEventStatuses: EventStatus[] = [...publicEventStatuses, 'ARCHIVED'];
const uploadEventStatuses: EventStatus[] = ['PUBLISHED', 'ONGOING', 'COMPLETED'];

function normalizeEventVisibility(status: EventStatus, visibility: 'PRIVATE' | 'PUBLIC') {
  if (status === 'SCHEDULED') throw new HttpError(400, 'USE_SCHEDULE_ENDPOINT', 'Use the schedule action to create or update a scheduled event.');
  if (status === 'DRAFT') return 'PRIVATE' as const;
  if (archiveEventStatuses.includes(status)) return 'PUBLIC' as const;
  return visibility;
}

function mediaUrl(publicKey?: string | null) {
  return publicKey ? `/api/v1/public/media?key=${encodeURIComponent(publicKey)}` : null;
}

function adminMediaUrl(id: string) {
  return `/api/v1/admin/media/${encodeURIComponent(id)}/preview`;
}

function eventToPublic(event: Prisma.EventGetPayload<{ include: { coverMedia: true; gallery: { include: { media: true } }; academicYear: true } }>) {
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    summary: event.summary,
    description: event.description,
    category: event.category,
    tags: event.tags,
    startAt: event.startAt,
    endAt: event.endAt,
    timezone: event.timezone,
    venue: event.venue,
    mapUrl: event.mapUrl,
    organizer: event.organizer,
    collaboratingOrganizations: event.collaboratingOrganizations,
    coordinators: event.coordinators,
    registrationUrl: event.registrationUrl,
    reportUrl: event.reportUrl,
    status: event.status,
    visibility: event.visibility,
    publicAt: event.publicAt,
    featured: event.featured,
    displayOrder: event.displayOrder,
    uploadOpensAt: event.uploadOpensAt,
    uploadClosesAt: event.uploadClosesAt,
    academicYear: event.academicYear ? { label: event.academicYear.label, slug: event.academicYear.slug } : null,
    cover: event.coverMedia?.publicKey ? { url: mediaUrl(event.coverMedia.publicKey), altText: event.coverMedia.altText } : null,
    gallery: event.gallery.filter((item) => item.publishedAt && item.media.status === 'PUBLIC' && item.media.publicKey).sort((a, b) => a.displayOrder - b.displayOrder).map((item) => ({ id: item.id, url: mediaUrl(item.media.publicKey), altText: item.altText || item.media.altText, caption: item.caption, credit: item.credit })),
  };
}

const eventInclude = { coverMedia: true, gallery: { include: { media: true } }, academicYear: true } as const;

function parseId(input: string | string[]) {
  const id = Array.isArray(input) ? input[0] : input;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, 'INVALID_ID', 'Invalid resource id.');
  return id;
}

// Health/readiness intentionally disclose only dependency status, never credentials.
apiRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'nss-api', timestamp: new Date().toISOString() }));
apiRouter.get('/ready', async (_req, res, next) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, database: 'ready' }); } catch { next(new HttpError(503, 'DATABASE_UNAVAILABLE', 'Database is not ready.')); }
});

// Authentication
apiRouter.get('/auth/csrf', (req, res) => res.json({ csrfToken: req.cookies?.[config.CSRF_COOKIE] ?? null }));
apiRouter.get('/auth/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));
apiRouter.post('/auth/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const email = validateRegistrationEmail(input.email);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists.');
    const user = await prisma.user.create({ data: { email, displayName: input.displayName, passwordHash: await hashPassword(input.password) } });
    const token = await issueEmailToken(user.id, 'VERIFY_EMAIL', 24);
    await sendMail(email, 'Verify your NSS IIIT Naya Raipur account', `Verify your account: ${config.MANAGE_ORIGIN}/manage/verify-email?token=${encodeURIComponent(token)}`);
    res.status(201).json({ message: 'Account created. Check your institutional inbox for the verification link.', userId: user.id });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/mobile/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const email = validateRegistrationEmail(input.email);
    if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists.');
    const user = await prisma.user.create({ data: { email, displayName: input.displayName, passwordHash: await hashPassword(input.password) } });
    const token = await issueEmailToken(user.id, 'VERIFY_EMAIL', 24);
    await sendMail(email, 'Verify your NSS IIIT Naya Raipur account', `Verify your account: ${config.MANAGE_ORIGIN}/manage/verify-email?token=${encodeURIComponent(token)}`);
    res.status(201).json({ message: 'Account created. Check your institutional inbox for the verification link.', userId: user.id });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const email = normalizeEmail(input.email);
    if (!/^[^\s@]+@iiitnr\.edu\.in$/i.test(email)) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.disabledAt || !(await verifyPassword(user.passwordHash, input.password))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    if (!user.emailVerifiedAt) throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your institutional email before signing in.');
    await establishSession(user.id, res);
    await audit(req, 'login', 'User', user.id);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/mobile/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const email = normalizeEmail(input.email);
    if (!isInstitutionalEmail(email)) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.disabledAt || !(await verifyPassword(user.passwordHash, input.password))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    if (!user.emailVerifiedAt) throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your institutional email before signing in.');
    const tokens = await establishMobileSession(user.id, req.get('user-agent'));
    await audit(req, 'mobile_login', 'User', user.id);
    res.json({ user: publicUser(user), ...tokens });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/mobile/refresh', async (req, res, next) => {
  try {
    const refreshToken = z.object({ refreshToken: z.string().min(40).max(300) }).parse(req.body).refreshToken;
    res.json(await rotateMobileSession(refreshToken, req.get('user-agent')));
  } catch (error) { next(error); }
});

apiRouter.post('/auth/mobile/logout', async (req, res, next) => {
  try {
    const refreshToken = z.object({ refreshToken: z.string().min(40).max(300).optional() }).parse(req.body ?? {}).refreshToken;
    if (refreshToken) await revokeMobileSession(refreshToken);
    if (req.mobileSessionId) await prisma.mobileSession.updateMany({ where: { id: req.mobileSessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    res.status(204).end();
  } catch (error) { next(error); }
});

apiRouter.get('/auth/verify', async (req, res, next) => {
  try {
    const token = tokenSchema.parse(req.query).token;
    await consumeEmailToken(token, 'VERIFY_EMAIL', async (tx, row) => {
      await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
    });
    res.redirect(`${config.MANAGE_ORIGIN}/manage/login?verified=1`);
  } catch (error) { next(error); }
});

apiRouter.post('/auth/forgot-password', async (req, res, next) => {
  try {
    const email = normalizeEmail(z.object({ email: z.string().email() }).parse(req.body).email);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && isInstitutionalEmail(email)) {
      const token = await issueEmailToken(user.id, 'RESET_PASSWORD', 1);
      await sendMail(email, 'Reset your NSS IIIT Naya Raipur password', `Reset your password: ${config.MANAGE_ORIGIN}/manage/reset-password?token=${encodeURIComponent(token)}`);
    }
    res.json({ message: 'If the address is eligible, a reset link has been sent.' });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/mobile/forgot-password', async (req, res, next) => {
  try {
    const email = normalizeEmail(z.object({ email: z.string().email() }).parse(req.body).email);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && isInstitutionalEmail(email)) { const token = await issueEmailToken(user.id, 'RESET_PASSWORD', 1); await sendMail(email, 'Reset your NSS IIIT Naya Raipur password', `Reset your password: ${config.MANAGE_ORIGIN}/manage/reset-password?token=${encodeURIComponent(token)}`); }
    res.json({ message: 'If the address is eligible, a reset link has been sent.' });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/reset-password', async (req, res, next) => {
  try {
    const input = z.object({ token: z.string().min(20), password: z.string().min(12).max(128) }).parse(req.body);
    await consumeEmailToken(input.token, 'RESET_PASSWORD', async (tx, row) => {
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(input.password) } });
      await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.mobileSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    res.json({ message: 'Password reset. You can sign in with the new password.' });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/mobile/reset-password', async (req, res, next) => {
  try {
    const input = z.object({ token: z.string().min(20), password: z.string().min(12).max(128) }).parse(req.body);
    await consumeEmailToken(input.token, 'RESET_PASSWORD', async (tx, row) => {
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(input.password) } });
      await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.mobileSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    res.json({ message: 'Password reset. You can sign in with the new password.' });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/logout', async (req, res, next) => { try { await revokeSession(req, res); res.status(204).end(); } catch (error) { next(error); } });

function isInstitutionalEmail(email: string) { return /^[^\s@]+@iiitnr\.edu\.in$/i.test(email); }

// Public read API
apiRouter.get('/public/home', async (_req, res, next) => {
  try {
    const [revision, metrics, director, events, team, settings] = await Promise.all([
      prisma.siteRevision.findFirst({ where: { key: 'homepage', status: 'PUBLISHED' }, orderBy: { version: 'desc' } }),
      prisma.impactMetric.findMany({ where: { visible: true }, orderBy: { displayOrder: 'asc' } }),
      prisma.directorMessage.findFirst({ where: { visible: true }, include: { portrait: true } }),
      prisma.event.findMany({ where: { status: { in: publicEventStatuses }, visibility: 'PUBLIC', deletedAt: null }, orderBy: [{ featured: 'desc' }, { displayOrder: 'asc' }, { startAt: 'desc' }], take: 12, include: eventInclude }),
      prisma.teamMember.findMany({ where: { active: true, publicVisible: true, featured: true }, orderBy: { displayOrder: 'asc' }, take: 24, include: { category: true, photoMedia: true } }),
      prisma.siteSetting.findMany(),
    ]);
    const content = revision ? parseHomepageContent({ ...(revision.content as object), metrics: metrics.map(({ number, label, suffix, progress, visible }) => ({ number, label, suffix, progress, visible })), values: { ...((revision.content as { values?: Record<string, string> }).values ?? {}), ...(director ? { 'director.name': director.name, 'director.designation': director.designation, 'director.text': director.text } : {}) } }) : null;
    res.json({ content, metrics, director: director ? { name: director.name, designation: director.designation, text: director.text, portrait: director.portrait?.publicKey ? mediaUrl(director.portrait.publicKey) : null } : null, events: events.map(eventToPublic), team: team.map((member) => ({ id: member.id, fullName: member.fullName, designation: member.designation, category: member.category.name, photo: member.photoMedia?.publicKey ? mediaUrl(member.photoMedia.publicKey) : null })), settings: Object.fromEntries(settings.map((setting) => [setting.key, setting.value])) });
  } catch (error) { next(error); }
});

apiRouter.get('/public/events', async (req, res, next) => {
  try {
    const query = paginationSchema.extend({ category: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: z.enum(['PUBLISHED', 'ONGOING', 'COMPLETED']).optional() }).parse(req.query);
    const where: Prisma.EventWhereInput = { visibility: 'PUBLIC', deletedAt: null, status: query.status ? query.status : { in: publicEventStatuses }, ...(query.category ? { category: query.category } : {}), ...(query.from || query.to ? { startAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}), ...(query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { summary: { contains: query.q, mode: 'insensitive' } }] } : {}) };
    const [total, events] = await Promise.all([prisma.event.count({ where }), prisma.event.findMany({ where, orderBy: { startAt: 'asc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: eventInclude })]);
    res.json({ items: events.map(eventToPublic), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) });
  } catch (error) { next(error); }
});

apiRouter.get('/public/events/:slug', async (req, res, next) => {
  try {
    if (req.params.slug.endsWith('.ics')) return next();
    const event = await prisma.event.findFirst({ where: { slug: req.params.slug, visibility: 'PUBLIC', deletedAt: null, status: { in: publicEventStatuses } }, include: eventInclude });
    if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', 'That published event could not be found.');
    res.json({ event: eventToPublic(event) });
  } catch (error) { next(error); }
});

apiRouter.get('/public/events/:slug.ics', async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({ where: { slug: req.params.slug, visibility: 'PUBLIC', deletedAt: null, status: { in: publicEventStatuses } } });
    if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', 'That published event could not be found.');
    const esc = (value: string) => value.replace(/[\\;,]/g, (char) => `\\${char}`).replace(/\n/g, '\\n');
    const dt = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const end = event.endAt ?? new Date(event.startAt.getTime() + 60 * 60 * 1000);
    res.type('text/calendar').send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NSS IIIT Naya Raipur//Events//EN', 'BEGIN:VEVENT', `UID:${event.id}@nss.iiitnr.edu.in`, `DTSTAMP:${dt(new Date())}`, `DTSTART:${dt(event.startAt)}`, `DTEND:${dt(end)}`, `SUMMARY:${esc(event.title)}`, `LOCATION:${esc(event.venue)}`, `DESCRIPTION:${esc(event.summary)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  } catch (error) { next(error); }
});

apiRouter.get('/public/media', async (req, res, next) => {
  try {
    const key = z.string().min(1).max(300).parse(req.query.key);
    const media = await prisma.mediaAsset.findFirst({ where: { publicKey: key, status: 'PUBLIC', OR: [{ source: 'legacy' }, { galleryItems: { some: { publishedAt: { not: null }, event: { visibility: 'PUBLIC', deletedAt: null, status: { in: archiveEventStatuses } } } } }, { coverFor: { some: { visibility: 'PUBLIC', deletedAt: null, status: { in: archiveEventStatuses } } } }, { teamPhotos: { some: { publicVisible: true, active: true } } }, { directorPhotos: { some: { visible: true } } }] } });
    if (!media) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Public media was not found.');
    res.sendFile(publicPath(key));
  } catch (error) { next(error); }
});

apiRouter.get('/public/team', async (_req, res, next) => {
  try {
    const members = await prisma.teamMember.findMany({ where: { active: true, publicVisible: true }, orderBy: [{ featured: 'desc' }, { displayOrder: 'asc' }, { fullName: 'asc' }], include: { category: true, photoMedia: true } });
    res.json({ items: members.map((member) => ({ id: member.id, fullName: member.fullName, designation: member.designation, batchYear: member.batchYear, biography: member.biography, category: member.category.name, photo: member.photoMedia?.publicKey ? mediaUrl(member.photoMedia.publicKey) : null, email: member.showEmail ? member.email : null, phone: member.showPhone ? member.phone : null })) });
  } catch (error) { next(error); }
});

apiRouter.get('/public/academic-years', async (_req, res, next) => {
  try {
    const years = await prisma.academicYear.findMany({ where: { published: true }, orderBy: { startsOn: 'desc' } });
    const items = await Promise.all(years.map(async (year) => { const [eventCount, rosterCount] = await Promise.all([prisma.event.count({ where: { academicYearId: year.id, visibility: 'PUBLIC', deletedAt: null, status: { in: archiveEventStatuses } } }), prisma.rosterMembership.count({ where: { academicYearId: year.id, member: { active: true, publicVisible: true } } })]); return { id: year.id, label: year.label, slug: year.slug, startsOn: year.startsOn, endsOn: year.endsOn, eventCount, rosterCount }; }));
    res.json({ items });
  } catch (error) { next(error); }
});

apiRouter.get('/public/academic-years/:slug', async (req, res, next) => {
  try {
    const year = await prisma.academicYear.findFirst({ where: { slug: req.params.slug, published: true }, include: { events: { where: { visibility: 'PUBLIC', deletedAt: null, status: { in: archiveEventStatuses } }, orderBy: { startAt: 'asc' }, include: eventInclude }, rosters: { include: { member: { include: { category: true, photoMedia: true } } }, orderBy: { displayOrder: 'asc' } } } });
    if (!year) throw new HttpError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'That academic-year archive was not found.');
    res.json({ year: { id: year.id, label: year.label, slug: year.slug, events: year.events.map(eventToPublic), roster: year.rosters.filter((entry) => entry.member.publicVisible).map((entry) => ({ fullName: entry.member.fullName, designation: entry.designation, category: entry.member.category.name, photo: entry.member.photoMedia?.publicKey ? mediaUrl(entry.member.photoMedia.publicKey) : null })) } });
  } catch (error) { next(error); }
});

// Contributor photo workflow
apiRouter.get('/me/photos', requireVerified, async (req, res, next) => {
  try {
    const photos = await prisma.photoSubmission.findMany({ where: { contributorId: req.user!.id }, orderBy: { submittedAt: 'desc' }, include: { event: { select: { title: true, slug: true } }, media: { select: { originalName: true, width: true, height: true } } } });
    res.json({ items: photos.map((photo) => ({ id: photo.id, event: photo.event, fileName: photo.media.originalName, width: photo.media.width, height: photo.media.height, status: photo.status, warnings: photo.qualityWarnings, rejectionReason: photo.rejectionReason, submittedAt: photo.submittedAt, creditRequested: photo.creditRequested })) });
  } catch (error) { next(error); }
});

apiRouter.post('/events/:id/photos', requireVerified, upload.array('photos', config.MAX_UPLOAD_FILES), async (req, res, next) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const results: Array<Record<string, unknown>> = [];
  try {
    const event = await prisma.event.findUnique({ where: { id: parseId(req.params.id) } });
    if (!event || event.deletedAt || event.visibility !== 'PUBLIC' || !uploadEventStatuses.includes(event.status)) throw new HttpError(404, 'EVENT_NOT_FOUND', 'The event is not available for photo submissions.');
    const now = new Date();
    if (!req.body.consent || req.body.consent !== 'true') throw new HttpError(400, 'CONSENT_REQUIRED', 'Confirm that you have permission to submit these photographs.');
    if ((event.uploadOpensAt && now < event.uploadOpensAt) || (event.uploadClosesAt && now > event.uploadClosesAt)) throw new HttpError(403, 'UPLOAD_WINDOW_CLOSED', 'Photo uploads are outside this event\'s configured upload window.');
    const clientIds = typeof req.body.clientSubmissionIds === 'string' ? JSON.parse(req.body.clientSubmissionIds) as unknown : [];
    if (!Array.isArray(clientIds)) throw new HttpError(400, 'CLIENT_IDS_INVALID', 'Upload identifiers are invalid.');
    for (const [index, file] of files.entries()) {
      const clientSubmissionId = String(clientIds[index] ?? `${req.user!.id}-${crypto.randomUUID()}`);
      let processed: Awaited<ReturnType<typeof processUpload>> | undefined;
      try {
        const prior = await prisma.photoSubmission.findUnique({ where: { clientSubmissionId }, select: { id: true, status: true } });
        if (prior) { await fs.rm(file.path, { force: true }).catch(() => undefined); results.push({ clientSubmissionId, id: prior.id, status: prior.status.toLowerCase() }); continue; }
        processed = await processUpload(file.path, file.originalname);
        const exact = await prisma.photoSubmission.findFirst({ where: { eventId: event.id, sha256: processed.sha256 } });
        if (exact) { await removePrivateUpload(processed.storageKey); results.push({ clientSubmissionId, status: 'duplicate', reason: 'EXACT_DUPLICATE', existingSubmissionId: exact.id }); continue; }
        const near = await prisma.photoSubmission.findMany({ where: { eventId: event.id, dHash: { not: null } }, select: { id: true, dHash: true } });
        const nearMatch = near.find((candidate) => hammingDistance(candidate.dHash, processed!.dHash) <= config.NEAR_DUPLICATE_HAMMING_DISTANCE);
        const submission = await prisma.$transaction(async (tx) => {
          const media = await tx.mediaAsset.create({ data: { storageKey: processed!.storageKey, originalName: processed!.originalName, mimeType: processed!.mimeType, sizeBytes: processed!.sizeBytes, width: processed!.width, height: processed!.height, sha256: processed!.sha256, dHash: processed!.dHash, status: 'PRIVATE', source: 'upload', createdById: req.user!.id } });
          return tx.photoSubmission.create({ data: { eventId: event.id, contributorId: req.user!.id, mediaId: media.id, clientSubmissionId, sha256: processed!.sha256, dHash: processed!.dHash, qualityWarnings: processed!.qualityWarnings, duplicateWarning: nearMatch ? `Near duplicate of an existing event photo (distance ${hammingDistance(nearMatch.dHash, processed!.dHash)}).` : null, duplicateOfId: nearMatch?.id ?? null, consentConfirmed: true, creditRequested: req.body.creditRequested === 'true' } });
        });
        results.push({ clientSubmissionId, id: submission.id, status: 'pending_review', warnings: processed!.qualityWarnings, duplicateWarning: submission.duplicateWarning });
      } catch (error) {
        results.push({ clientSubmissionId, status: 'failed', code: error instanceof HttpError ? error.code : 'PROCESSING_FAILED', message: error instanceof HttpError ? error.message : 'This image could not be processed.' });
        await fs.rm(file.path, { force: true }).catch(() => undefined);
        if (processed) await removePrivateUpload(processed.storageKey);
      }
    }
    res.status(207).json({ items: results });
  } catch (error) {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => undefined)));
    next(error);
  }
});

// Admin event records and media library
apiRouter.get('/admin/events/:id/participants', requireRole('ADMIN'), async (req, res, next) => { try { const query = paginationSchema.parse(req.query); const eventId = parseId(req.params.id); const where: Prisma.EventParticipantWhereInput = { eventId, ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { department: { contains: query.q, mode: 'insensitive' } }, { role: { contains: query.q, mode: 'insensitive' } }] } : {}) }; const [total, items] = await Promise.all([prisma.eventParticipant.count({ where }), prisma.eventParticipant.findMany({ where, orderBy: { name: 'asc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize })]); res.json({ items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) }); } catch (error) { next(error); } });
const participantSchema = z.object({ name: z.string().trim().min(2).max(180), rollNo: z.string().trim().max(80).nullable().optional(), role: z.string().trim().max(180).default(''), department: z.string().trim().max(180).default(''), batch: z.string().trim().max(80).default(''), contribution: z.string().trim().max(500).default(''), attendance: z.string().trim().max(80).default('present'), sourceKey: z.string().trim().max(240).optional() });
apiRouter.post('/admin/events/:id/participants', requireRole('ADMIN'), async (req, res, next) => { try { const eventId = parseId(req.params.id); const input = participantSchema.parse(req.body); const sourceKey = input.sourceKey || `manual:${crypto.randomUUID()}`; const item = await prisma.eventParticipant.create({ data: { ...input, sourceKey, eventId } }); await audit(req, 'event_participant_created', 'EventParticipant', item.id, { eventId }); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.patch('/admin/events/:id/participants/:participantId', requireRole('ADMIN'), async (req, res, next) => { try { const eventId = parseId(req.params.id); const itemId = parseId(req.params.participantId); const input = participantSchema.partial().omit({ sourceKey: true }).parse(req.body); const existing = await prisma.eventParticipant.findFirst({ where: { id: itemId, eventId } }); if (!existing) throw new HttpError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found for this event.'); const item = await prisma.eventParticipant.update({ where: { id: itemId }, data: input }); await audit(req, 'event_participant_updated', 'EventParticipant', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.delete('/admin/events/:id/participants/:participantId', requireRole('ADMIN'), async (req, res, next) => { try { const eventId = parseId(req.params.id); const itemId = parseId(req.params.participantId); const existing = await prisma.eventParticipant.findFirst({ where: { id: itemId, eventId } }); if (!existing) throw new HttpError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found for this event.'); await prisma.eventParticipant.delete({ where: { id: itemId } }); await audit(req, 'event_participant_deleted', 'EventParticipant', itemId); res.status(204).end(); } catch (error) { next(error); } });
apiRouter.post('/admin/events/:id/participants/import', requireRole('ADMIN'), async (req, res, next) => { try { const eventId = parseId(req.params.id); const rows = z.array(participantSchema).max(5000).parse(req.body.rows); const items = await prisma.$transaction(rows.map((row) => prisma.eventParticipant.upsert({ where: { eventId_sourceKey: { eventId, sourceKey: row.sourceKey || `import:${crypto.createHash('sha256').update(`${row.name}|${row.rollNo || ''}|${row.role}`).digest('hex')}` } }, update: row, create: { ...row, sourceKey: row.sourceKey || `import:${crypto.createHash('sha256').update(`${row.name}|${row.rollNo || ''}|${row.role}`).digest('hex')}`, eventId } }))); await audit(req, 'event_participants_imported', 'Event', eventId, { count: items.length }); res.status(201).json({ items, count: items.length }); } catch (error) { next(error); } });
apiRouter.get('/admin/events/:id/participants.csv', requireRole('ADMIN'), async (req, res, next) => { try { const rows = await prisma.eventParticipant.findMany({ where: { eventId: parseId(req.params.id) }, orderBy: { name: 'asc' } }); const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`; const csv = [['Name', 'Roll No', 'Role', 'Department', 'Batch', 'Contribution', 'Attendance'], ...rows.map((row) => [row.name, row.rollNo, row.role, row.department, row.batch, row.contribution, row.attendance])].map((row) => row.map(csvCell).join(',')).join('\r\n'); res.type('text/csv').attachment('participants.csv').send(csv); } catch (error) { next(error); } });

apiRouter.get('/admin/media', requireRole('ADMIN'), async (req, res, next) => { try { const query = paginationSchema.extend({ status: z.enum(['PRIVATE', 'PUBLIC', 'REMOVED']).optional() }).parse(req.query); const where: Prisma.MediaAssetWhereInput = { ...(query.status ? { status: query.status } : {}), ...(query.q ? { originalName: { contains: query.q, mode: 'insensitive' } } : {}) }; const [total, items] = await Promise.all([prisma.mediaAsset.count({ where }), prisma.mediaAsset.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { coverFor: { select: { id: true, title: true } }, galleryItems: { select: { eventId: true } }, teamPhotos: { select: { id: true, fullName: true } }, directorPhotos: { select: { id: true } } } })]); res.json({ items: items.map((item) => ({ ...item, url: item.publicKey ? adminMediaUrl(item.id) : null, usageCount: item.coverFor.length + item.galleryItems.length + item.teamPhotos.length + item.directorPhotos.length })), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) }); } catch (error) { next(error); } });
apiRouter.get('/admin/media/:id/preview', requireRole('ADMIN'), async (req, res, next) => { try { const item = await prisma.mediaAsset.findUnique({ where: { id: parseId(req.params.id) } }); if (!item || item.status === 'REMOVED' || !item.publicKey) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Media asset not found.'); res.set('Cache-Control', 'private, no-store').sendFile(publicPath(item.publicKey)); } catch (error) { next(error); } });
apiRouter.post('/admin/media', requireRole('ADMIN'), upload.single('file'), async (req, res, next) => { const file = req.file; let processed: Awaited<ReturnType<typeof processUpload>> | undefined; let derivative: { publicKey: string; thumbKey: string } | undefined; try { if (!file) throw new HttpError(400, 'FILE_REQUIRED', 'Choose an image to upload.'); processed = await processUpload(file.path, file.originalname); derivative = await createPublicDerivative(processed.storageKey); const item = await prisma.mediaAsset.create({ data: { storageKey: processed.storageKey, publicKey: derivative.publicKey, originalName: processed.originalName, mimeType: processed.mimeType, sizeBytes: processed.sizeBytes, width: processed.width, height: processed.height, sha256: processed.sha256, dHash: processed.dHash, status: 'PUBLIC', source: 'admin', altText: z.string().max(500).parse(req.body.altText || ''), caption: z.string().max(1000).parse(req.body.caption || ''), createdById: req.user!.id } }); await audit(req, 'media_created', 'MediaAsset', item.id, { source: 'admin' }); res.status(201).json({ item: { ...item, url: adminMediaUrl(item.id) }, warnings: processed.qualityWarnings }); } catch (error) { if (file) await fs.rm(file.path, { force: true }).catch(() => undefined); if (processed) await removePrivateUpload(processed.storageKey); if (derivative) await removePublicDerivative(derivative.publicKey); next(error); } });
apiRouter.patch('/admin/media/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ altText: z.string().max(500).optional(), caption: z.string().max(1000).optional() }).parse(req.body); const item = await prisma.mediaAsset.update({ where: { id: parseId(req.params.id) }, data: input }); await audit(req, 'media_updated', 'MediaAsset', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.delete('/admin/media/:id', requireRole('ADMIN'), async (req, res, next) => { try { const item = await prisma.mediaAsset.findUnique({ where: { id: parseId(req.params.id) }, include: { coverFor: true, galleryItems: true, teamPhotos: true, directorPhotos: true } }); if (!item) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Media asset not found.'); if (item.coverFor.length || item.galleryItems.length || item.teamPhotos.length || item.directorPhotos.length) throw new HttpError(409, 'MEDIA_IN_USE', 'Replace or remove every reference before deleting this asset.'); await prisma.mediaAsset.update({ where: { id: item.id }, data: { status: 'REMOVED', publicKey: null } }); await removePrivateUpload(item.storageKey); if (item.publicKey) await removePublicDerivative(item.publicKey); await audit(req, 'media_removed', 'MediaAsset', item.id); res.status(204).end(); } catch (error) { next(error); } });

// Moderation queue
apiRouter.get('/moderation/photos', requireRole('APPROVER', 'ADMIN'), async (req, res, next) => {
  try {
    const query = paginationSchema.extend({ eventId: z.string().optional(), warning: z.string().optional(), status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REMOVAL_REQUESTED']).default('PENDING_REVIEW') }).parse(req.query);
    const where: Prisma.PhotoSubmissionWhereInput = { status: query.status, ...(query.eventId ? { eventId: query.eventId } : {}), ...(query.q ? { media: { originalName: { contains: query.q, mode: 'insensitive' } } } : {}), ...(query.warning ? { OR: [{ duplicateWarning: { contains: query.warning, mode: 'insensitive' } }, { qualityWarnings: { array_contains: query.warning } }] } : {}) };
    const [total, items] = await Promise.all([prisma.photoSubmission.count({ where }), prisma.photoSubmission.findMany({ where, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { submittedAt: 'asc' }, include: { event: { select: { id: true, title: true, slug: true } }, contributor: { select: { id: true, displayName: true, email: true } }, media: true, decisions: { orderBy: { createdAt: 'desc' }, take: 3, include: { reviewer: { select: { displayName: true, role: true } } } } } })]);
    res.json({ items: items.map((item) => ({ id: item.id, event: item.event, contributor: item.contributor, fileName: item.media.originalName, width: item.media.width, height: item.media.height, warnings: item.qualityWarnings, duplicateWarning: item.duplicateWarning, status: item.status, submittedAt: item.submittedAt, previewUrl: `/api/v1/moderation/photos/${item.id}/preview`, decisions: item.decisions })), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) });
  } catch (error) { next(error); }
});

apiRouter.get('/moderation/photos/:id/preview', requireRole('APPROVER', 'ADMIN'), async (req, res, next) => {
  try {
    const photo = await prisma.photoSubmission.findUnique({ where: { id: parseId(req.params.id) }, include: { media: true } });
    if (!photo) throw new HttpError(404, 'PHOTO_NOT_FOUND', 'Photo submission not found.');
    res.sendFile(privatePath(photo.media.storageKey));
  } catch (error) { next(error); }
});

async function decidePhoto(req: Request, submissionId: string, action: 'approve' | 'reject', reason?: string) {
  return decidePublication(req.user!, submissionId, action, reason);
}

apiRouter.post('/moderation/photos/:id/decision', requireRole('APPROVER', 'ADMIN'), async (req, res, next) => {
  try { const input = moderationSchema.parse(req.body); const item = await decidePhoto(req, parseId(req.params.id), input.action, input.reason); res.json({ item: { id: item.id, status: item.status, rejectionReason: item.rejectionReason } }); } catch (error) { next(error); }
});

apiRouter.post('/moderation/photos/bulk-decision', requireRole('APPROVER', 'ADMIN'), async (req, res, next) => {
  try { const input = z.object({ ids: z.array(z.string()).min(1).max(100), action: z.enum(['approve', 'reject']), reason: z.string().optional() }).parse(req.body); const items = []; for (const id of input.ids) { try { items.push(await decidePhoto(req, id, input.action, input.reason)); } catch (error) { items.push({ id, error: error instanceof HttpError ? error.message : 'Unable to decide' }); } } res.json({ items }); } catch (error) { next(error); }
});

apiRouter.post('/photos/:id/removal-request', requireVerified, async (req, res, next) => {
  try { const input = photoRemovalSchema.parse(req.body); const item = await prisma.photoSubmission.findUnique({ where: { id: parseId(req.params.id) } }); if (!item || item.contributorId !== req.user!.id || item.status !== 'PUBLISHED') throw new HttpError(404, 'PHOTO_NOT_FOUND', 'Published photo not found.'); const request = await prisma.photoRemovalRequest.create({ data: { submissionId: item.id, requesterId: req.user!.id, reason: input.reason } }); await prisma.photoSubmission.update({ where: { id: item.id }, data: { status: 'REMOVAL_REQUESTED' } }); res.status(201).json({ requestId: request.id }); } catch (error) { next(error); }
});
apiRouter.get('/moderation/removals', requireRole('APPROVER', 'ADMIN'), async (_req, res, next) => { try { const items = await prisma.photoRemovalRequest.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, include: { requester: { select: { displayName: true } }, submission: { include: { event: { select: { title: true, slug: true } }, media: true } } } }); res.json({ items: items.map((item) => ({ id: item.id, reason: item.reason, requester: item.requester, event: item.submission.event, submissionId: item.submissionId, previewUrl: item.submission.media.publicKey ? mediaUrl(item.submission.media.publicKey) : null })) }); } catch (error) { next(error); } });
apiRouter.post('/moderation/removals/:id/decision', requireRole('APPROVER', 'ADMIN'), async (req, res, next) => { try { const input = z.object({ action: z.enum(['approve', 'reject']) }).parse(req.body); const request = await prisma.photoRemovalRequest.findUnique({ where: { id: parseId(req.params.id) }, include: { submission: { include: { media: true } } } }); if (!request || request.status !== 'pending') throw new HttpError(404, 'REMOVAL_REQUEST_NOT_FOUND', 'Removal request not found.'); if (request.requesterId === req.user!.id) throw new HttpError(403, 'SELF_REMOVAL_REVIEW_FORBIDDEN', 'Another reviewer must decide on your removal request.'); const approved = input.action === 'approve'; await prisma.$transaction([prisma.photoRemovalRequest.update({ where: { id: request.id }, data: { status: approved ? 'approved' : 'rejected', reviewedById: req.user!.id, reviewedAt: new Date() } }), prisma.photoSubmission.update({ where: { id: request.submissionId }, data: { status: approved ? 'REMOVED' : 'PUBLISHED', removedAt: approved ? new Date() : null } }), prisma.notification.create({ data: { userId: request.submission.contributorId, type: 'PHOTO_REMOVAL_DECISION', title: approved ? 'Photo removed' : 'Photo kept published', body: approved ? 'Your photo removal request was approved.' : 'Your photo removal request was reviewed and the photo remains published.', link: '/manage/photos' } }), ...(approved ? [prisma.mediaAsset.update({ where: { id: request.submission.mediaId }, data: { status: 'REMOVED' } }), prisma.eventGalleryItem.updateMany({ where: { eventId: request.submission.eventId, mediaId: request.submission.mediaId }, data: { publishedAt: null } })] : [])]); if (approved && request.submission.media.publicKey) await removePublicDerivative(request.submission.media.publicKey); await audit(req, `photo_removal_${input.action}`, 'PhotoRemovalRequest', request.id, { submissionId: request.submissionId }); res.json({ id: request.id, status: approved ? 'approved' : 'rejected' }); } catch (error) { next(error); } });

// Admin dashboard/content/event management
apiRouter.get('/admin/content/homepage', requireRole('ADMIN'), async (_req, res, next) => { try { const revisions = await prisma.siteRevision.findMany({ where: { key: 'homepage' }, orderBy: { version: 'desc' }, take: 20, include: { createdBy: { select: { displayName: true } } } }); res.json({ items: revisions }); } catch (error) { next(error); } });
apiRouter.post('/admin/content/homepage/revisions', requireRole('ADMIN'), async (req, res, next) => { try { const patch = z.record(z.string(), z.unknown()).parse(req.body.content); const latest = await prisma.siteRevision.findFirst({ where: { key: 'homepage' }, orderBy: { version: 'desc' } }); const content = parseHomepageContent(mergeHomepageContent(latest?.content ?? patch, patch)); const revision = await prisma.siteRevision.create({ data: { key: 'homepage', version: (latest?.version ?? 0) + 1, content: content as Prisma.InputJsonValue, status: 'DRAFT', createdById: req.user!.id } }); await audit(req, 'homepage_revision_created', 'SiteRevision', revision.id, { version: revision.version }); res.status(201).json({ revision }); } catch (error) { next(error); } });
apiRouter.post('/admin/content/homepage/revisions/:id/publish', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const revision = await prisma.$transaction(async (tx) => { const candidate = await tx.siteRevision.findUnique({ where: { id } }); if (!candidate || candidate.key !== 'homepage') throw new HttpError(404, 'REVISION_NOT_FOUND', 'Homepage revision not found.'); if (!['DRAFT', 'SCHEDULED'].includes(candidate.status)) throw new HttpError(409, 'REVISION_NOT_PUBLISHABLE', 'Only a draft or scheduled revision can be published.'); parseHomepageContent(candidate.content); await tx.siteRevision.updateMany({ where: { key: 'homepage', status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } }); await tx.scheduledJob.updateMany({ where: { key: { startsWith: 'homepage:' }, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLED', lockedAt: null } }); return tx.siteRevision.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date(), scheduledAt: null } }); }); await audit(req, 'homepage_published', 'SiteRevision', revision.id, { version: revision.version }); res.json({ revision }); } catch (error) { next(error); } });
apiRouter.post('/admin/content/homepage/revisions/:id/schedule', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const runAt = z.object({ runAt: z.coerce.date() }).parse(req.body).runAt; if (runAt <= new Date()) throw new HttpError(400, 'SCHEDULE_IN_PAST', 'Choose a future time.'); const revision = await prisma.$transaction(async (tx) => { const candidate = await tx.siteRevision.findUnique({ where: { id } }); if (!candidate || candidate.key !== 'homepage') throw new HttpError(404, 'REVISION_NOT_FOUND', 'Homepage revision not found.'); parseHomepageContent(candidate.content); await tx.siteRevision.updateMany({ where: { key: 'homepage', status: 'SCHEDULED', id: { not: id } }, data: { status: 'DRAFT', scheduledAt: null } }); await tx.scheduledJob.updateMany({ where: { key: { startsWith: 'homepage:' }, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLED', lockedAt: null } }); return tx.siteRevision.update({ where: { id }, data: { status: 'SCHEDULED', scheduledAt: runAt } }); }); await prisma.scheduledJob.upsert({ where: { key: `homepage:${revision.id}` }, update: { runAt, status: 'PENDING', payload: { revisionId: revision.id }, lastError: null }, create: { key: `homepage:${revision.id}`, type: 'SITE_PUBLISH', runAt, payload: { revisionId: revision.id }, createdById: req.user!.id } }); await audit(req, 'homepage_scheduled', 'SiteRevision', revision.id, { runAt }); res.json({ revision }); } catch (error) { next(error); } });
apiRouter.get('/admin/metrics', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.impactMetric.findMany({ orderBy: { displayOrder: 'asc' } }) }); } catch (error) { next(error); } });
apiRouter.post('/admin/metrics', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ number: z.number().int(), label: z.string().min(1).max(180), suffix: z.string().max(20).default(''), progress: z.number().min(0).max(1).nullable().optional(), displayOrder: z.number().int().min(0).default(0), visible: z.boolean().default(true) }).parse(req.body); const item = await prisma.impactMetric.create({ data: input }); await audit(req, 'metric_created', 'ImpactMetric', item.id); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.patch('/admin/metrics/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ number: z.number().int().optional(), label: z.string().min(1).max(180).optional(), suffix: z.string().max(20).optional(), progress: z.number().min(0).max(1).nullable().optional(), displayOrder: z.number().int().min(0).optional(), visible: z.boolean().optional() }).parse(req.body); const item = await prisma.impactMetric.update({ where: { id: parseId(req.params.id) }, data: input }); await audit(req, 'metric_updated', 'ImpactMetric', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.delete('/admin/metrics/:id', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); await prisma.impactMetric.delete({ where: { id } }); await audit(req, 'metric_deleted', 'ImpactMetric', id); res.status(204).end(); } catch (error) { next(error); } });
apiRouter.get('/admin/director', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ item: await prisma.directorMessage.findFirst({ include: { portrait: true } }) }); } catch (error) { next(error); } });
apiRouter.put('/admin/director', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ name: z.string().min(2).max(180), designation: z.string().min(2).max(180), text: z.string().min(2).max(5000), portraitId: z.string().cuid().nullable().optional(), visible: z.boolean().default(true) }).parse(req.body); const existing = await prisma.directorMessage.findFirst(); const item = existing ? await prisma.directorMessage.update({ where: { id: existing.id }, data: input }) : await prisma.directorMessage.create({ data: input }); await audit(req, 'director_message_updated', 'DirectorMessage', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.get('/admin/team', requireRole('ADMIN'), async (_req, res, next) => { try { const items = await prisma.teamMember.findMany({ orderBy: [{ displayOrder: 'asc' }, { fullName: 'asc' }], include: { category: true, photoMedia: true } }); res.json({ items: items.map((item) => ({ ...item, photo: item.photoMedia?.publicKey ? mediaUrl(item.photoMedia.publicKey) : null })) }); } catch (error) { next(error); } });
apiRouter.get('/admin/team/categories', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.teamCategory.findMany({ orderBy: { name: 'asc' } }) }); } catch (error) { next(error); } });
apiRouter.post('/admin/team/categories', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ name: z.string().min(2).max(80), slug: z.string().regex(/^[a-z0-9-]+$/).max(90) }).parse(req.body); const item = await prisma.teamCategory.create({ data: input }); await audit(req, 'team_category_created', 'TeamCategory', item.id); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.post('/admin/team', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ fullName: z.string().min(2).max(180), designation: z.string().min(2).max(180), categoryId: z.string().cuid(), batchYear: z.string().max(30).nullable().optional(), biography: z.string().max(5000).nullable().optional(), email: z.string().email().nullable().optional(), phone: z.string().max(30).nullable().optional(), photoMediaId: z.string().cuid().nullable().optional(), displayOrder: z.number().int().min(0).default(0), featured: z.boolean().default(false), active: z.boolean().default(true), publicVisible: z.boolean().default(true), showEmail: z.boolean().default(false), showPhone: z.boolean().default(false) }).parse(req.body); const item = await prisma.teamMember.create({ data: { ...input, createdById: req.user!.id } }); await audit(req, 'team_member_created', 'TeamMember', item.id); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.patch('/admin/team/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ fullName: z.string().min(2).max(180).optional(), designation: z.string().min(2).max(180).optional(), categoryId: z.string().cuid().optional(), batchYear: z.string().max(30).nullable().optional(), biography: z.string().max(5000).nullable().optional(), photoMediaId: z.string().cuid().nullable().optional(), displayOrder: z.number().int().min(0).optional(), featured: z.boolean().optional(), active: z.boolean().optional(), publicVisible: z.boolean().optional(), showEmail: z.boolean().optional(), showPhone: z.boolean().optional() }).parse(req.body); const item = await prisma.teamMember.update({ where: { id: parseId(req.params.id) }, data: input }); await audit(req, 'team_member_updated', 'TeamMember', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.post('/admin/team/:id/archive', requireRole('ADMIN'), async (req, res, next) => { try { const item = await prisma.teamMember.update({ where: { id: parseId(req.params.id) }, data: { active: false, publicVisible: false } }); await audit(req, 'team_member_archived', 'TeamMember', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.get('/admin/academic-years', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.academicYear.findMany({ orderBy: { startsOn: 'desc' } }) }); } catch (error) { next(error); } });
apiRouter.post('/admin/academic-years', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ label: z.string().min(4).max(40), slug: z.string().regex(/^[a-z0-9-]+$/), startsOn: z.coerce.date(), endsOn: z.coerce.date(), published: z.boolean().default(false) }).parse(req.body); if (input.endsOn <= input.startsOn) throw new HttpError(400, 'ACADEMIC_YEAR_INVALID', 'End date must be after start date.'); const item = await prisma.academicYear.create({ data: input }); await audit(req, 'academic_year_created', 'AcademicYear', item.id); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.patch('/admin/academic-years/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ label: z.string().min(4).max(40).optional(), startsOn: z.coerce.date().optional(), endsOn: z.coerce.date().optional(), published: z.boolean().optional(), isCurrent: z.boolean().optional() }).parse(req.body); const id = parseId(req.params.id); const before = await prisma.academicYear.findUnique({ where: { id } }); if (!before) throw new HttpError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found.'); const startsOn = input.startsOn ?? before.startsOn; const endsOn = input.endsOn ?? before.endsOn; if (endsOn <= startsOn) throw new HttpError(400, 'ACADEMIC_YEAR_INVALID', 'End date must be after start date.'); const item = await prisma.$transaction(async (tx) => { if (input.isCurrent) await tx.academicYear.updateMany({ where: { id: { not: id } }, data: { isCurrent: false } }); return tx.academicYear.update({ where: { id }, data: { ...input, startsOn, endsOn } }); }); await audit(req, 'academic_year_updated', 'AcademicYear', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.get('/admin/academic-years/:id', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const item = await prisma.academicYear.findUnique({ where: { id }, include: { events: { orderBy: { startAt: 'asc' }, include: eventInclude }, rosters: { orderBy: { displayOrder: 'asc' }, include: { member: { include: { category: true, photoMedia: true } } } } } }); if (!item) throw new HttpError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found.'); res.json({ item: { ...item, events: item.events.map(eventToPublic) } }); } catch (error) { next(error); } });
apiRouter.post('/admin/academic-years/:id/publish', requireRole('ADMIN'), async (req, res, next) => { try { const item = await prisma.academicYear.update({ where: { id: parseId(req.params.id) }, data: { published: true } }); await audit(req, 'academic_year_published', 'AcademicYear', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.post('/admin/academic-years/:id/unpublish', requireRole('ADMIN'), async (req, res, next) => { try { const item = await prisma.academicYear.update({ where: { id: parseId(req.params.id) }, data: { published: false } }); await audit(req, 'academic_year_unpublished', 'AcademicYear', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.post('/admin/academic-years/:id/roster', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const input = z.object({ memberId: z.string().cuid(), designation: z.string().min(2).max(180), displayOrder: z.number().int().min(0).default(0), featured: z.boolean().default(false) }).parse(req.body); const item = await prisma.rosterMembership.upsert({ where: { memberId_academicYearId: { memberId: input.memberId, academicYearId: id } }, update: input, create: { ...input, academicYearId: id } }); await audit(req, 'academic_year_roster_assigned', 'RosterMembership', item.id, { academicYearId: id, memberId: input.memberId }); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.patch('/admin/academic-years/:id/roster/:membershipId', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ designation: z.string().min(2).max(180).optional(), displayOrder: z.number().int().min(0).optional(), featured: z.boolean().optional() }).parse(req.body); const item = await prisma.rosterMembership.update({ where: { id: parseId(req.params.membershipId) }, data: input }); await audit(req, 'academic_year_roster_updated', 'RosterMembership', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.delete('/admin/academic-years/:id/roster/:membershipId', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const membershipId = parseId(req.params.membershipId); const existing = await prisma.rosterMembership.findFirst({ where: { id: membershipId, academicYearId: id } }); if (!existing) throw new HttpError(404, 'ROSTER_MEMBERSHIP_NOT_FOUND', 'Roster membership not found.'); await prisma.rosterMembership.delete({ where: { id: membershipId } }); await audit(req, 'academic_year_roster_removed', 'RosterMembership', membershipId, { academicYearId: id }); res.status(204).end(); } catch (error) { next(error); } });
apiRouter.get('/admin/dashboard', requireRole('ADMIN'), async (_req, res, next) => {
  try {
    const [events, users, pending, published, jobs, activity] = await Promise.all([prisma.event.count(), prisma.user.count(), prisma.photoSubmission.count({ where: { status: 'PENDING_REVIEW' } }), prisma.photoSubmission.count({ where: { status: 'PUBLISHED' } }), prisma.scheduledJob.count({ where: { status: 'PENDING' } }), prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8, include: { actor: { select: { displayName: true, role: true } } } })]);
    res.json({ counts: { events, users, pendingModeration: pending, publishedPhotos: published, scheduledJobs: jobs }, activity });
  } catch (error) { next(error); }
});
apiRouter.get('/admin/scheduled', requireRole('ADMIN'), async (_req, res, next) => { try { const items = await prisma.scheduledJob.findMany({ orderBy: { runAt: 'asc' }, take: 100 }); res.json({ items }); } catch (error) { next(error); } });
apiRouter.post('/admin/scheduled/:id/cancel', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const item = await prisma.$transaction(async (tx) => {
      const job = await tx.scheduledJob.findUnique({ where: { id } });
      if (!job) throw new HttpError(404, 'SCHEDULED_JOB_NOT_FOUND', 'Scheduled job not found.');
      if (job.status !== 'PENDING') throw new HttpError(409, 'SCHEDULED_JOB_NOT_CANCELLABLE', 'Only pending jobs can be cancelled.');
      const payload = job.payload as { eventId?: unknown; revisionId?: unknown };
      if (job.type === 'EVENT_PUBLISH' && typeof payload.eventId === 'string') {
        await tx.event.updateMany({ where: { id: payload.eventId, status: 'SCHEDULED' }, data: { status: 'DRAFT', visibility: 'PRIVATE', publicAt: null } });
      }
      if (job.type === 'SITE_PUBLISH' && typeof payload.revisionId === 'string') {
        await tx.siteRevision.updateMany({ where: { id: payload.revisionId, status: 'SCHEDULED' }, data: { status: 'DRAFT', scheduledAt: null } });
      }
      return tx.scheduledJob.update({ where: { id }, data: { status: 'CANCELLED', lockedAt: null } });
    });
    await audit(req, 'scheduled_job_cancelled', 'ScheduledJob', item.id);
    res.json({ item });
  } catch (error) { next(error); }
});
apiRouter.get('/admin/backup-status', requireRole('ADMIN'), async (_req, res, next) => { try { const [privateStats, publicStats, backupEntries] = await Promise.all([fs.statfs(config.PRIVATE_MEDIA_ROOT), fs.statfs(config.PUBLIC_MEDIA_ROOT), fs.readdir(config.BACKUP_ROOT, { withFileTypes: true }).catch(() => [])]); const usage = (stats: { blocks: number; bavail: number; bsize: number }) => ({ usedBytes: (stats.blocks - stats.bavail) * stats.bsize, availableBytes: stats.bavail * stats.bsize }); const latest = backupEntries.filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name))[0]; const lastBackup = latest ? new Date(latest.name.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')).toISOString() : null; res.json({ status: { privateMedia: usage(privateStats), publicMedia: usage(publicStats), lastBackup } }); } catch (error) { next(error); } });
apiRouter.get('/me/notifications', requireAuth, async (req, res, next) => { try { const items = await prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 30 }); res.json({ items }); } catch (error) { next(error); } });
apiRouter.post('/me/notifications/:id/read', requireAuth, async (req, res, next) => { try { const item = await prisma.notification.updateMany({ where: { id: parseId(req.params.id), userId: req.user!.id }, data: { readAt: new Date() } }); res.json({ updated: item.count === 1 }); } catch (error) { next(error); } });

apiRouter.get('/admin/events', requireRole('ADMIN', 'APPROVER'), async (req, res, next) => {
  try { const query = paginationSchema.extend({ status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ONGOING', 'COMPLETED', 'CANCELLED', 'ARCHIVED']).optional() }).parse(req.query); const where: Prisma.EventWhereInput = { deletedAt: null, ...(query.status ? { status: query.status } : {}), ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}) }; const [total, events] = await Promise.all([prisma.event.count({ where }), prisma.event.findMany({ where, orderBy: { startAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: eventInclude })]); res.json({ items: events.map(eventToPublic), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) }); } catch (error) { next(error); }
});

apiRouter.post('/admin/events', requireRole('ADMIN'), async (req, res, next) => {
  try { const input = eventSchema.parse(req.body); const uploadOpensAt = input.uploadOpensAt ?? new Date(); const uploadClosesAt = input.uploadClosesAt ?? new Date(Math.max(Date.now(), (input.endAt ?? input.startAt).getTime()) + 30 * 86_400_000); const status = input.status as EventStatus; const visibility = normalizeEventVisibility(status, input.visibility); const event = await prisma.event.create({ data: { ...input, uploadOpensAt, uploadClosesAt, socialUrls: input.socialUrls, coverMediaId: input.coverMediaId ?? null, endAt: input.endAt ?? null, mapUrl: input.mapUrl ?? null, registrationUrl: input.registrationUrl ?? null, academicYearId: input.academicYearId ?? null, seoTitle: input.seoTitle ?? null, seoDescription: input.seoDescription ?? null, visibility, status } }); await audit(req, 'event_created', 'Event', event.id, { slug: event.slug, uploadOpensAt, uploadClosesAt }); res.status(201).json({ event: eventToPublic(await prisma.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude })) }); } catch (error) { next(error); }
});

apiRouter.patch('/admin/events/:id', requireRole('ADMIN'), async (req, res, next) => {
  try { const input = eventSchema.partial().parse(req.body); const before = await prisma.event.findUnique({ where: { id: parseId(req.params.id) } }); if (!before) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.'); const status = (input.status ?? before.status) as EventStatus; const visibility = normalizeEventVisibility(status, input.visibility ?? before.visibility); const event = await prisma.$transaction(async (tx) => { const updated = await tx.event.update({ where: { id: before.id }, data: { ...input, socialUrls: input.socialUrls, coverMediaId: input.coverMediaId, endAt: input.endAt, mapUrl: input.mapUrl, registrationUrl: input.registrationUrl, reportUrl: input.reportUrl, academicYearId: input.academicYearId, seoTitle: input.seoTitle, seoDescription: input.seoDescription, status, visibility } }); if (input.status && input.status !== 'SCHEDULED') await tx.scheduledJob.updateMany({ where: { key: `event-publish:${before.id}`, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLED', lockedAt: null } }); return updated; }); await audit(req, 'event_updated', 'Event', event.id, { before: { status: before.status, slug: before.slug }, after: { status: event.status, slug: event.slug } }); res.json({ event: eventToPublic(await prisma.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude })) }); } catch (error) { next(error); }
});

apiRouter.post('/admin/events/:id/publish', requireRole('ADMIN'), async (req, res, next) => {
  try { const event = await prisma.$transaction(async (tx) => { const current = await tx.event.findUnique({ where: { id: parseId(req.params.id) } }); if (!current || current.deletedAt || current.status === 'CANCELLED') throw new HttpError(409, 'EVENT_NOT_PUBLISHABLE', 'This event cannot be published in its current state.'); const published = await tx.event.update({ where: { id: current.id }, data: { status: 'PUBLISHED', visibility: 'PUBLIC', publicAt: new Date() } }); await tx.scheduledJob.updateMany({ where: { key: `event-publish:${current.id}`, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLED', lockedAt: null } }); return published; }); await publishApprovedSubmissions(event.id); await audit(req, 'event_published', 'Event', event.id); res.json({ event: eventToPublic(await prisma.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude })) }); } catch (error) { next(error); }
});

apiRouter.post('/admin/events/:id/schedule', requireRole('ADMIN'), async (req, res, next) => {
  try { const input = z.object({ runAt: z.coerce.date() }).parse(req.body); if (input.runAt <= new Date()) throw new HttpError(400, 'SCHEDULE_IN_PAST', 'Choose a future publication time.'); const current = await prisma.event.findUnique({ where: { id: parseId(req.params.id) } }); if (!current || current.deletedAt || current.status === 'ARCHIVED' || current.status === 'CANCELLED') throw new HttpError(409, 'EVENT_NOT_SCHEDULABLE', 'This event cannot be scheduled.'); const event = await prisma.event.update({ where: { id: current.id }, data: { status: 'SCHEDULED', visibility: 'PUBLIC', publicAt: input.runAt } }); await prisma.scheduledJob.upsert({ where: { key: `event-publish:${event.id}` }, update: { runAt: input.runAt, status: 'PENDING', payload: { eventId: event.id }, lastError: null, lockedAt: null }, create: { key: `event-publish:${event.id}`, type: 'EVENT_PUBLISH', runAt: input.runAt, payload: { eventId: event.id }, createdById: req.user!.id } }); await audit(req, 'event_scheduled', 'Event', event.id, { runAt: input.runAt }); res.json({ event: { id: event.id, status: event.status, publicAt: event.publicAt } }); } catch (error) { next(error); }
});

apiRouter.post('/admin/events/:id/archive', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const event = await prisma.$transaction(async (tx) => { const updated = await tx.event.update({ where: { id }, data: { status: 'ARCHIVED', visibility: 'PUBLIC' } }); await tx.scheduledJob.updateMany({ where: { key: `event-publish:${id}`, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLED', lockedAt: null } }); return updated; }); await audit(req, 'event_archived', 'Event', event.id); res.json({ id: event.id, status: event.status }); } catch (error) { next(error); } });
apiRouter.post('/admin/events/:id/unpublish', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const event = await prisma.$transaction(async (tx) => { const updated = await tx.event.update({ where: { id }, data: { status: 'DRAFT', visibility: 'PRIVATE', publicAt: null } }); await tx.scheduledJob.updateMany({ where: { key: `event-publish:${id}`, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLED', lockedAt: null } }); return updated; }); await audit(req, 'event_unpublished', 'Event', event.id); res.json({ id: event.id, status: event.status, visibility: event.visibility }); } catch (error) { next(error); } });
apiRouter.delete('/admin/events/:id', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const confirmation = z.object({ confirm: z.literal('DELETE') }).parse(req.body); void confirmation; const event = await prisma.$transaction(async (tx) => { const updated = await tx.event.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED', visibility: 'PRIVATE', publicAt: null } }); await tx.scheduledJob.updateMany({ where: { key: `event-publish:${id}`, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLED', lockedAt: null } }); return updated; }); await audit(req, 'event_deleted', 'Event', id, { softDelete: true }); res.json({ id: event.id, deletedAt: event.deletedAt }); } catch (error) { next(error); } });

async function publishApprovedSubmissions(eventId: string) {
  await releasePhotos(eventId);
}

apiRouter.get('/admin/settings', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.siteSetting.findMany({ orderBy: { key: 'asc' } }) }); } catch (error) { next(error); } });
apiRouter.put('/admin/settings/:key', requireRole('ADMIN'), async (req, res, next) => { try { const key = z.string().regex(/^[a-z0-9_.-]+$/).parse(req.params.key); const value = z.unknown().parse(req.body.value); const item = await prisma.siteSetting.upsert({ where: { key }, update: { value: value as Prisma.InputJsonValue }, create: { key, value: value as Prisma.InputJsonValue } }); await audit(req, 'setting_updated', 'SiteSetting', item.id, { key }); res.json({ item }); } catch (error) { next(error); } });
apiRouter.get('/admin/audit', requireRole('ADMIN'), async (req, res, next) => { try { const query = paginationSchema.parse(req.query); const [total, items] = await Promise.all([prisma.auditLog.count(), prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { actor: { select: { displayName: true, email: true, role: true } } } })]); res.json({ items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) }); } catch (error) { next(error); } });

// Basic role/user administration. There is deliberately no self-service role mutation.
apiRouter.get('/admin/users', requireRole('ADMIN'), async (_req, res, next) => { try { const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, email: true, displayName: true, role: true, emailVerifiedAt: true, disabledAt: true, createdAt: true } }); res.json({ items: users }); } catch (error) { next(error); } });
apiRouter.patch('/admin/users/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ role: z.enum(['USER', 'APPROVER', 'ADMIN']).optional(), disabled: z.boolean().optional() }).parse(req.body); const id = parseId(req.params.id); if (id === req.user!.id && input.role && input.role !== 'ADMIN') throw new HttpError(400, 'SELF_ROLE_CHANGE_FORBIDDEN', 'Use another admin to change your own role.'); const before = await prisma.user.findUnique({ where: { id } }); if (!before) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.'); const updated = await prisma.$transaction(async (tx) => { const user = await tx.user.update({ where: { id }, data: { ...(input.role ? { role: input.role as Role } : {}), ...(typeof input.disabled === 'boolean' ? { disabledAt: input.disabled ? new Date() : null } : {}) }, select: { id: true, email: true, displayName: true, role: true, disabledAt: true } }); if (input.role || input.disabled) { await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }); await tx.mobileSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }); } return user; }); await audit(req, 'user_access_updated', 'User', id, { before: { role: before.role, disabled: Boolean(before.disabledAt) }, after: { role: updated.role, disabled: Boolean(updated.disabledAt) } }); res.json({ user: updated }); } catch (error) { next(error); } });

export async function publishScheduledEvent(eventId: string) {
  const event = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${eventId} FOR UPDATE`;
    const current = await tx.event.findUnique({ where: { id: eventId } });
    if (!current || current.deletedAt || current.status !== 'SCHEDULED' || (current.publicAt && current.publicAt > new Date())) return null;
    return tx.event.update({ where: { id: eventId }, data: { status: 'PUBLISHED', visibility: 'PUBLIC', publicAt: current.publicAt ?? new Date() } });
  });
  if (event) await publishApprovedSubmissions(eventId);
}

export function addErrorMiddleware(app: express.Express, notFoundHandler: (req: Request, res: Response, next: NextFunction) => void, errorHandler: NextFunction) {
  app.use(notFoundHandler);
  app.use(errorHandler as express.ErrorRequestHandler);
}

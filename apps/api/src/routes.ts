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
import { ensureCsrfCookie, hashToken, normalizeEmail, requireCsrf } from './security.js';
import { attachUser, establishSession, hashPassword, issueEmailToken, publicUser, requireAuth, requireRole, requireVerified, revokeSession, validateRegistrationEmail, verifyPassword } from './auth.js';
import { loginSchema, eventSchema, moderationSchema, paginationSchema, photoRemovalSchema, registerSchema, tokenSchema } from './validation.js';
import { hammingDistance, privatePath, processUpload, publicPath } from './media.js';
import { sendMail } from './mail.js';
import { decide as decidePublication, releasePhotos } from './publication.js';

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

function mediaUrl(publicKey?: string | null) {
  return publicKey ? `/api/v1/public/media?key=${encodeURIComponent(publicKey)}` : null;
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
    await sendMail(email, 'Verify your NSS IIIT Naya Raipur account', `Verify your account: ${config.MAIL_PREVIEW_BASE_URL}/verify?token=${encodeURIComponent(token)}`);
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

apiRouter.get('/auth/verify', async (req, res, next) => {
  try {
    const token = tokenSchema.parse(req.query).token;
    const row = await prisma.emailToken.findFirst({ where: { tokenHash: hashToken(token), type: 'VERIFY_EMAIL', usedAt: null, expiresAt: { gt: new Date() } } });
    if (!row) throw new HttpError(400, 'TOKEN_INVALID', 'This verification link is invalid or expired.');
    await prisma.$transaction([prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }), prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } })]);
    res.redirect(`${config.MANAGE_ORIGIN}/login?verified=1`);
  } catch (error) { next(error); }
});

apiRouter.post('/auth/forgot-password', async (req, res, next) => {
  try {
    const email = normalizeEmail(z.object({ email: z.string().email() }).parse(req.body).email);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && isInstitutionalEmail(email)) {
      const token = await issueEmailToken(user.id, 'RESET_PASSWORD', 1);
      await sendMail(email, 'Reset your NSS IIIT Naya Raipur password', `Reset your password: ${config.MAIL_PREVIEW_BASE_URL}/reset?token=${encodeURIComponent(token)}`);
    }
    res.json({ message: 'If the address is eligible, a reset link has been sent.' });
  } catch (error) { next(error); }
});

apiRouter.post('/auth/reset-password', async (req, res, next) => {
  try {
    const input = z.object({ token: z.string().min(20), password: z.string().min(12).max(128) }).parse(req.body);
    const row = await prisma.emailToken.findFirst({ where: { tokenHash: hashToken(input.token), type: 'RESET_PASSWORD', usedAt: null, expiresAt: { gt: new Date() } } });
    if (!row) throw new HttpError(400, 'TOKEN_INVALID', 'This reset link is invalid or expired.');
    await prisma.$transaction([prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }), prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(input.password) } }), prisma.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } })]);
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
    res.json({ content: revision?.content ?? null, metrics, director: director ? { name: director.name, designation: director.designation, text: director.text, portrait: director.portrait?.publicKey ? mediaUrl(director.portrait.publicKey) : null } : null, events: events.map(eventToPublic), team: team.map((member) => ({ id: member.id, fullName: member.fullName, designation: member.designation, category: member.category.name, photo: member.photoMedia?.publicKey ? mediaUrl(member.photoMedia.publicKey) : null })), settings: Object.fromEntries(settings.map((setting) => [setting.key, setting.value])) });
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
    const years = await prisma.academicYear.findMany({ where: { published: true }, orderBy: { startsOn: 'desc' }, include: { _count: { select: { events: true, rosters: true } } } });
    res.json({ items: years.map((year) => ({ id: year.id, label: year.label, slug: year.slug, startsOn: year.startsOn, endsOn: year.endsOn, eventCount: year._count.events, rosterCount: year._count.rosters })) });
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
      try {
        const prior = await prisma.photoSubmission.findUnique({ where: { clientSubmissionId }, select: { id: true, status: true } });
        if (prior) { results.push({ clientSubmissionId, id: prior.id, status: prior.status.toLowerCase() }); continue; }
        const processed = await processUpload(file.path, file.originalname);
        const exact = await prisma.photoSubmission.findFirst({ where: { eventId: event.id, sha256: processed.sha256 } });
        if (exact) { results.push({ clientSubmissionId, status: 'duplicate', reason: 'EXACT_DUPLICATE', existingSubmissionId: exact.id }); continue; }
        const near = await prisma.photoSubmission.findMany({ where: { eventId: event.id, dHash: { not: null } }, select: { id: true, dHash: true } });
        const nearMatch = near.find((candidate) => hammingDistance(candidate.dHash, processed.dHash) <= config.NEAR_DUPLICATE_HAMMING_DISTANCE);
        const media = await prisma.mediaAsset.create({ data: { storageKey: processed.storageKey, originalName: processed.originalName, mimeType: processed.mimeType, sizeBytes: processed.sizeBytes, width: processed.width, height: processed.height, sha256: processed.sha256, dHash: processed.dHash, status: 'PRIVATE', source: 'upload', createdById: req.user!.id } });
        const submission = await prisma.photoSubmission.create({ data: { eventId: event.id, contributorId: req.user!.id, mediaId: media.id, clientSubmissionId, sha256: processed.sha256, dHash: processed.dHash, qualityWarnings: processed.qualityWarnings, duplicateWarning: nearMatch ? `Near duplicate of an existing event photo (distance ${hammingDistance(nearMatch.dHash, processed.dHash)}).` : null, duplicateOfId: nearMatch?.id ?? null, consentConfirmed: true, creditRequested: req.body.creditRequested === 'true' } });
        results.push({ clientSubmissionId, id: submission.id, status: 'pending_review', warnings: processed.qualityWarnings, duplicateWarning: submission.duplicateWarning });
      } catch (error) {
        results.push({ clientSubmissionId, status: 'failed', code: error instanceof HttpError ? error.code : 'PROCESSING_FAILED', message: error instanceof HttpError ? error.message : 'This image could not be processed.' });
        await fs.rm(file.path, { force: true }).catch(() => undefined);
      }
    }
    res.status(207).json({ items: results });
  } catch (error) {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => undefined)));
    next(error);
  }
});

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
apiRouter.post('/moderation/removals/:id/decision', requireRole('APPROVER', 'ADMIN'), async (req, res, next) => { try { const input = z.object({ action: z.enum(['approve', 'reject']) }).parse(req.body); const request = await prisma.photoRemovalRequest.findUnique({ where: { id: parseId(req.params.id) }, include: { submission: { include: { media: true } } } }); if (!request || request.status !== 'pending') throw new HttpError(404, 'REMOVAL_REQUEST_NOT_FOUND', 'Removal request not found.'); const approved = input.action === 'approve'; await prisma.$transaction([prisma.photoRemovalRequest.update({ where: { id: request.id }, data: { status: approved ? 'approved' : 'rejected', reviewedById: req.user!.id, reviewedAt: new Date() } }), prisma.photoSubmission.update({ where: { id: request.submissionId }, data: { status: approved ? 'REMOVED' : 'PUBLISHED', removedAt: approved ? new Date() : null } }), ...(approved ? [prisma.mediaAsset.update({ where: { id: request.submission.mediaId }, data: { status: 'REMOVED' } }), prisma.eventGalleryItem.updateMany({ where: { eventId: request.submission.eventId, mediaId: request.submission.mediaId }, data: { publishedAt: null } })] : [])]); if (approved && request.submission.media.publicKey) await fs.rm(publicPath(request.submission.media.publicKey), { force: true }).catch(() => undefined); await audit(req, `photo_removal_${input.action}`, 'PhotoRemovalRequest', request.id, { submissionId: request.submissionId }); res.json({ id: request.id, status: approved ? 'approved' : 'rejected' }); } catch (error) { next(error); } });

// Admin dashboard/content/event management
apiRouter.get('/admin/content/homepage', requireRole('ADMIN'), async (_req, res, next) => { try { const revisions = await prisma.siteRevision.findMany({ where: { key: 'homepage' }, orderBy: { version: 'desc' }, take: 20, include: { createdBy: { select: { displayName: true } } } }); res.json({ items: revisions }); } catch (error) { next(error); } });
apiRouter.post('/admin/content/homepage/revisions', requireRole('ADMIN'), async (req, res, next) => { try { const content = z.record(z.string(), z.unknown()).parse(req.body.content); const latest = await prisma.siteRevision.findFirst({ where: { key: 'homepage' }, orderBy: { version: 'desc' } }); const revision = await prisma.siteRevision.create({ data: { key: 'homepage', version: (latest?.version ?? 0) + 1, content: content as Prisma.InputJsonValue, status: 'DRAFT', createdById: req.user!.id } }); await audit(req, 'homepage_revision_created', 'SiteRevision', revision.id, { version: revision.version }); res.status(201).json({ revision }); } catch (error) { next(error); } });
apiRouter.post('/admin/content/homepage/revisions/:id/publish', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const revision = await prisma.$transaction(async (tx) => { await tx.siteRevision.updateMany({ where: { key: 'homepage', status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } }); return tx.siteRevision.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date(), scheduledAt: null } }); }); await audit(req, 'homepage_published', 'SiteRevision', revision.id, { version: revision.version }); res.json({ revision }); } catch (error) { next(error); } });
apiRouter.post('/admin/content/homepage/revisions/:id/schedule', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const runAt = z.object({ runAt: z.coerce.date() }).parse(req.body).runAt; if (runAt <= new Date()) throw new HttpError(400, 'SCHEDULE_IN_PAST', 'Choose a future time.'); const revision = await prisma.siteRevision.update({ where: { id }, data: { status: 'SCHEDULED', scheduledAt: runAt } }); await prisma.scheduledJob.upsert({ where: { key: `homepage:${revision.id}` }, update: { runAt, status: 'PENDING', payload: { revisionId: revision.id } }, create: { key: `homepage:${revision.id}`, type: 'SITE_PUBLISH', runAt, payload: { revisionId: revision.id }, createdById: req.user!.id } }); await audit(req, 'homepage_scheduled', 'SiteRevision', revision.id, { runAt }); res.json({ revision }); } catch (error) { next(error); } });
apiRouter.get('/admin/metrics', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.impactMetric.findMany({ orderBy: { displayOrder: 'asc' } }) }); } catch (error) { next(error); } });
apiRouter.post('/admin/metrics', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ number: z.number().int(), label: z.string().min(1).max(180), suffix: z.string().max(20).default(''), progress: z.number().min(0).max(1).nullable().optional(), displayOrder: z.number().int().min(0).default(0), visible: z.boolean().default(true) }).parse(req.body); const item = await prisma.impactMetric.create({ data: input }); await audit(req, 'metric_created', 'ImpactMetric', item.id); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.patch('/admin/metrics/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ number: z.number().int().optional(), label: z.string().min(1).max(180).optional(), suffix: z.string().max(20).optional(), progress: z.number().min(0).max(1).nullable().optional(), displayOrder: z.number().int().min(0).optional(), visible: z.boolean().optional() }).parse(req.body); const item = await prisma.impactMetric.update({ where: { id: parseId(req.params.id) }, data: input }); await audit(req, 'metric_updated', 'ImpactMetric', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.delete('/admin/metrics/:id', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); await prisma.impactMetric.delete({ where: { id } }); await audit(req, 'metric_deleted', 'ImpactMetric', id); res.status(204).end(); } catch (error) { next(error); } });
apiRouter.get('/admin/director', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ item: await prisma.directorMessage.findFirst({ include: { portrait: true } }) }); } catch (error) { next(error); } });
apiRouter.put('/admin/director', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ name: z.string().min(2).max(180), designation: z.string().min(2).max(180), text: z.string().min(2).max(5000), portraitId: z.string().cuid().nullable().optional(), visible: z.boolean().default(true) }).parse(req.body); const existing = await prisma.directorMessage.findFirst(); const item = existing ? await prisma.directorMessage.update({ where: { id: existing.id }, data: input }) : await prisma.directorMessage.create({ data: input }); await audit(req, 'director_message_updated', 'DirectorMessage', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.get('/admin/team', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.teamMember.findMany({ orderBy: [{ displayOrder: 'asc' }, { fullName: 'asc' }], include: { category: true, photoMedia: true } }) }); } catch (error) { next(error); } });
apiRouter.get('/admin/team/categories', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.teamCategory.findMany({ orderBy: { name: 'asc' } }) }); } catch (error) { next(error); } });
apiRouter.post('/admin/team/categories', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ name: z.string().min(2).max(80), slug: z.string().regex(/^[a-z0-9-]+$/).max(90) }).parse(req.body); const item = await prisma.teamCategory.create({ data: input }); await audit(req, 'team_category_created', 'TeamCategory', item.id); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.post('/admin/team', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ fullName: z.string().min(2).max(180), designation: z.string().min(2).max(180), categoryId: z.string().cuid(), batchYear: z.string().max(30).nullable().optional(), biography: z.string().max(5000).nullable().optional(), email: z.string().email().nullable().optional(), phone: z.string().max(30).nullable().optional(), photoMediaId: z.string().cuid().nullable().optional(), displayOrder: z.number().int().min(0).default(0), featured: z.boolean().default(false), active: z.boolean().default(true), publicVisible: z.boolean().default(true), showEmail: z.boolean().default(false), showPhone: z.boolean().default(false) }).parse(req.body); const item = await prisma.teamMember.create({ data: { ...input, createdById: req.user!.id } }); await audit(req, 'team_member_created', 'TeamMember', item.id); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.patch('/admin/team/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ fullName: z.string().min(2).max(180).optional(), designation: z.string().min(2).max(180).optional(), categoryId: z.string().cuid().optional(), batchYear: z.string().max(30).nullable().optional(), biography: z.string().max(5000).nullable().optional(), photoMediaId: z.string().cuid().nullable().optional(), displayOrder: z.number().int().min(0).optional(), featured: z.boolean().optional(), active: z.boolean().optional(), publicVisible: z.boolean().optional(), showEmail: z.boolean().optional(), showPhone: z.boolean().optional() }).parse(req.body); const item = await prisma.teamMember.update({ where: { id: parseId(req.params.id) }, data: input }); await audit(req, 'team_member_updated', 'TeamMember', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.post('/admin/team/:id/archive', requireRole('ADMIN'), async (req, res, next) => { try { const item = await prisma.teamMember.update({ where: { id: parseId(req.params.id) }, data: { active: false, publicVisible: false } }); await audit(req, 'team_member_archived', 'TeamMember', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.get('/admin/academic-years', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.academicYear.findMany({ orderBy: { startsOn: 'desc' } }) }); } catch (error) { next(error); } });
apiRouter.post('/admin/academic-years', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ label: z.string().min(4).max(40), slug: z.string().regex(/^[a-z0-9-]+$/), startsOn: z.coerce.date(), endsOn: z.coerce.date(), published: z.boolean().default(false) }).parse(req.body); if (input.endsOn <= input.startsOn) throw new HttpError(400, 'ACADEMIC_YEAR_INVALID', 'End date must be after start date.'); const item = await prisma.academicYear.create({ data: input }); await audit(req, 'academic_year_created', 'AcademicYear', item.id); res.status(201).json({ item }); } catch (error) { next(error); } });
apiRouter.patch('/admin/academic-years/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ label: z.string().min(4).max(40).optional(), startsOn: z.coerce.date().optional(), endsOn: z.coerce.date().optional(), published: z.boolean().optional(), isCurrent: z.boolean().optional() }).parse(req.body); const item = await prisma.academicYear.update({ where: { id: parseId(req.params.id) }, data: input }); await audit(req, 'academic_year_updated', 'AcademicYear', item.id); res.json({ item }); } catch (error) { next(error); } });
apiRouter.get('/admin/dashboard', requireRole('ADMIN'), async (_req, res, next) => {
  try {
    const [events, users, pending, published, jobs, activity] = await Promise.all([prisma.event.count(), prisma.user.count(), prisma.photoSubmission.count({ where: { status: 'PENDING_REVIEW' } }), prisma.photoSubmission.count({ where: { status: 'PUBLISHED' } }), prisma.scheduledJob.count({ where: { status: 'PENDING' } }), prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8, include: { actor: { select: { displayName: true, role: true } } } })]);
    res.json({ counts: { events, users, pendingModeration: pending, publishedPhotos: published, scheduledJobs: jobs }, activity });
  } catch (error) { next(error); }
});
apiRouter.get('/me/notifications', requireAuth, async (req, res, next) => { try { const items = await prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 30 }); res.json({ items }); } catch (error) { next(error); } });
apiRouter.post('/me/notifications/:id/read', requireAuth, async (req, res, next) => { try { const item = await prisma.notification.updateMany({ where: { id: parseId(req.params.id), userId: req.user!.id }, data: { readAt: new Date() } }); res.json({ updated: item.count === 1 }); } catch (error) { next(error); } });

apiRouter.get('/admin/events', requireRole('ADMIN', 'APPROVER'), async (req, res, next) => {
  try { const query = paginationSchema.extend({ status: z.string().optional() }).parse(req.query); const where: Prisma.EventWhereInput = { deletedAt: null, ...(query.status ? { status: query.status as EventStatus } : {}), ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}) }; const [total, events] = await Promise.all([prisma.event.count({ where }), prisma.event.findMany({ where, orderBy: { startAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: eventInclude })]); res.json({ items: events.map(eventToPublic), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) }); } catch (error) { next(error); }
});

apiRouter.post('/admin/events', requireRole('ADMIN'), async (req, res, next) => {
  try { const input = eventSchema.parse(req.body); const uploadOpensAt = input.uploadOpensAt ?? new Date(); const uploadClosesAt = input.uploadClosesAt ?? new Date(Math.max(Date.now(), (input.endAt ?? input.startAt).getTime()) + 30 * 86_400_000); const event = await prisma.event.create({ data: { ...input, uploadOpensAt, uploadClosesAt, socialUrls: input.socialUrls, coverMediaId: input.coverMediaId ?? null, endAt: input.endAt ?? null, mapUrl: input.mapUrl ?? null, registrationUrl: input.registrationUrl ?? null, academicYearId: input.academicYearId ?? null, seoTitle: input.seoTitle ?? null, seoDescription: input.seoDescription ?? null, visibility: input.visibility, status: input.status } }); await audit(req, 'event_created', 'Event', event.id, { slug: event.slug, uploadOpensAt, uploadClosesAt }); res.status(201).json({ event: eventToPublic(await prisma.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude })) }); } catch (error) { next(error); }
});

apiRouter.patch('/admin/events/:id', requireRole('ADMIN'), async (req, res, next) => {
  try { const input = eventSchema.partial().parse(req.body); const before = await prisma.event.findUnique({ where: { id: parseId(req.params.id) } }); if (!before) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.'); const event = await prisma.event.update({ where: { id: before.id }, data: { ...input, socialUrls: input.socialUrls, coverMediaId: input.coverMediaId, endAt: input.endAt, mapUrl: input.mapUrl, registrationUrl: input.registrationUrl, reportUrl: input.reportUrl, academicYearId: input.academicYearId, seoTitle: input.seoTitle, seoDescription: input.seoDescription } }); await audit(req, 'event_updated', 'Event', event.id, { before: { status: before.status, slug: before.slug }, after: { status: event.status, slug: event.slug } }); res.json({ event: eventToPublic(await prisma.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude })) }); } catch (error) { next(error); }
});

apiRouter.post('/admin/events/:id/publish', requireRole('ADMIN'), async (req, res, next) => {
  try { const event = await prisma.event.update({ where: { id: parseId(req.params.id) }, data: { status: 'PUBLISHED', visibility: 'PUBLIC', publicAt: new Date() } }); await publishApprovedSubmissions(event.id); await audit(req, 'event_published', 'Event', event.id); res.json({ event: eventToPublic(await prisma.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude })) }); } catch (error) { next(error); }
});

apiRouter.post('/admin/events/:id/schedule', requireRole('ADMIN'), async (req, res, next) => {
  try { const input = z.object({ runAt: z.coerce.date() }).parse(req.body); if (input.runAt <= new Date()) throw new HttpError(400, 'SCHEDULE_IN_PAST', 'Choose a future publication time.'); const event = await prisma.event.update({ where: { id: parseId(req.params.id) }, data: { status: 'SCHEDULED', visibility: 'PUBLIC', publicAt: input.runAt } }); await prisma.scheduledJob.upsert({ where: { key: `event-publish:${event.id}` }, update: { runAt: input.runAt, status: 'PENDING', payload: { eventId: event.id }, lastError: null }, create: { key: `event-publish:${event.id}`, type: 'EVENT_PUBLISH', runAt: input.runAt, payload: { eventId: event.id }, createdById: req.user!.id } }); await audit(req, 'event_scheduled', 'Event', event.id, { runAt: input.runAt }); res.json({ event: { id: event.id, status: event.status, publicAt: event.publicAt } }); } catch (error) { next(error); }
});

apiRouter.post('/admin/events/:id/archive', requireRole('ADMIN'), async (req, res, next) => { try { const event = await prisma.event.update({ where: { id: parseId(req.params.id) }, data: { status: 'ARCHIVED' } }); await audit(req, 'event_archived', 'Event', event.id); res.json({ id: event.id, status: event.status }); } catch (error) { next(error); } });
apiRouter.post('/admin/events/:id/unpublish', requireRole('ADMIN'), async (req, res, next) => { try { const event = await prisma.event.update({ where: { id: parseId(req.params.id) }, data: { status: 'DRAFT', visibility: 'PRIVATE', publicAt: null } }); await audit(req, 'event_unpublished', 'Event', event.id); res.json({ id: event.id, status: event.status, visibility: event.visibility }); } catch (error) { next(error); } });
apiRouter.delete('/admin/events/:id', requireRole('ADMIN'), async (req, res, next) => { try { const id = parseId(req.params.id); const confirmation = z.object({ confirm: z.literal('DELETE') }).parse(req.body); void confirmation; const event = await prisma.event.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED', visibility: 'PRIVATE', publicAt: null } }); await audit(req, 'event_deleted', 'Event', id, { softDelete: true }); res.json({ id: event.id, deletedAt: event.deletedAt }); } catch (error) { next(error); } });

async function publishApprovedSubmissions(eventId: string) {
  await releasePhotos(eventId);
}

apiRouter.get('/admin/settings', requireRole('ADMIN'), async (_req, res, next) => { try { res.json({ items: await prisma.siteSetting.findMany({ orderBy: { key: 'asc' } }) }); } catch (error) { next(error); } });
apiRouter.put('/admin/settings/:key', requireRole('ADMIN'), async (req, res, next) => { try { const key = z.string().regex(/^[a-z0-9_.-]+$/).parse(req.params.key); const value = z.unknown().parse(req.body.value); const item = await prisma.siteSetting.upsert({ where: { key }, update: { value: value as Prisma.InputJsonValue }, create: { key, value: value as Prisma.InputJsonValue } }); await audit(req, 'setting_updated', 'SiteSetting', item.id, { key }); res.json({ item }); } catch (error) { next(error); } });
apiRouter.get('/admin/audit', requireRole('ADMIN'), async (req, res, next) => { try { const query = paginationSchema.parse(req.query); const [total, items] = await Promise.all([prisma.auditLog.count(), prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { actor: { select: { displayName: true, email: true, role: true } } } })]); res.json({ items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) }); } catch (error) { next(error); } });

// Basic role/user administration. There is deliberately no self-service role mutation.
apiRouter.get('/admin/users', requireRole('ADMIN'), async (_req, res, next) => { try { const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, email: true, displayName: true, role: true, emailVerifiedAt: true, disabledAt: true, createdAt: true } }); res.json({ items: users }); } catch (error) { next(error); } });
apiRouter.patch('/admin/users/:id', requireRole('ADMIN'), async (req, res, next) => { try { const input = z.object({ role: z.enum(['USER', 'APPROVER', 'ADMIN']).optional(), disabled: z.boolean().optional() }).parse(req.body); const id = parseId(req.params.id); if (id === req.user!.id && input.role && input.role !== 'ADMIN') throw new HttpError(400, 'SELF_ROLE_CHANGE_FORBIDDEN', 'Use another admin to change your own role.'); const before = await prisma.user.findUnique({ where: { id } }); if (!before) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.'); const updated = await prisma.user.update({ where: { id }, data: { ...(input.role ? { role: input.role as Role } : {}), ...(typeof input.disabled === 'boolean' ? { disabledAt: input.disabled ? new Date() : null } : {}) }, select: { id: true, email: true, displayName: true, role: true, disabledAt: true } }); await audit(req, 'user_access_updated', 'User', id, { before: { role: before.role, disabled: Boolean(before.disabledAt) }, after: { role: updated.role, disabled: Boolean(updated.disabledAt) } }); res.json({ user: updated }); } catch (error) { next(error); } });

export async function publishScheduledEvent(eventId: string) {
  const event = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${eventId} FOR UPDATE`;
    const current = await tx.event.findUnique({ where: { id: eventId } });
    if (!current || current.status === 'PUBLISHED') return current;
    return tx.event.update({ where: { id: eventId }, data: { status: 'PUBLISHED', visibility: 'PUBLIC', publicAt: current.publicAt ?? new Date() } });
  });
  if (event) await publishApprovedSubmissions(eventId);
}

export function addErrorMiddleware(app: express.Express, notFoundHandler: (req: Request, res: Response, next: NextFunction) => void, errorHandler: NextFunction) {
  app.use(notFoundHandler);
  app.use(errorHandler as express.ErrorRequestHandler);
}

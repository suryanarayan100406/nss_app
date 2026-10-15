import argon2 from 'argon2';
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { type Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { HttpError } from './errors.js';
import { config } from './config.js';
import { hashToken, isEligibleEmail, normalizeEmail, randomToken } from './security.js';
import type { Role } from '@prisma/client';
import { roleRank } from './types.js';

export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = req.cookies?.[config.SESSION_COOKIE];
    if (raw) {
      const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
      if (session && !session.revokedAt && session.expiresAt >= new Date() && !session.user.disabledAt) {
        req.sessionId = session.id;
        req.user = toAuthUser(session.user);
        return next();
      }
    }
    const authorization = req.get('authorization');
    if (authorization?.startsWith('Bearer ')) {
      const access = verifyMobileAccessToken(authorization.slice(7));
      if (access) {
        const session = await prisma.mobileSession.findUnique({ where: { id: access.sessionId }, include: { user: true } });
        if (session && !session.revokedAt && session.expiresAt >= new Date() && access.expiresAt >= Date.now() && !session.user.disabledAt) {
          req.mobileSessionId = session.id;
          req.user = toAuthUser(session.user);
        }
      }
    }
    next();
  } catch (error) {
    // Public HTML has an authored static fallback when the database is down.
    // API requests still surface the dependency error to the normal handler.
    if (!req.baseUrl) return next();
    next(error);
  }
}

function toAuthUser(user: { id: string; email: string; displayName: string; role: Role; emailVerifiedAt: Date | null; disabledAt: Date | null }) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, emailVerifiedAt: user.emailVerifiedAt, disabledAt: user.disabledAt };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'AUTH_REQUIRED', 'Please sign in to continue.'));
  next();
}

export function requireVerified(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'AUTH_REQUIRED', 'Please sign in to continue.'));
  if (!req.user.emailVerifiedAt) return next(new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your IIIT Naya Raipur email address first.'));
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'AUTH_REQUIRED', 'Please sign in to continue.'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action.'));
    next();
  };
}

export function hasRoleAtLeast(actual: Role, required: Role) {
  return roleRank[actual] >= roleRank[required];
}

export async function establishSession(userId: string, res: Response) {
  const raw = randomToken(48);
  await prisma.session.create({ data: { tokenHash: hashToken(raw), userId, expiresAt: new Date(Date.now() + config.SESSION_DAYS * 86_400_000) } });
  res.cookie(config.SESSION_COOKIE, raw, { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, path: '/', maxAge: config.SESSION_DAYS * 86_400_000 });
}

const MOBILE_ACCESS_MS = 15 * 60 * 1000;
const MOBILE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

function accessSignature(payload: string) {
  return crypto.createHmac('sha256', `${config.SESSION_SECRET}:mobile-access`).update(payload).digest('base64url');
}

function signMobileAccessToken(userId: string, sessionId: string) {
  const expiresAt = Date.now() + MOBILE_ACCESS_MS;
  const payload = Buffer.from(JSON.stringify({ sub: userId, sid: sessionId, exp: expiresAt }), 'utf8').toString('base64url');
  return `${payload}.${accessSignature(payload)}`;
}

function verifyMobileAccessToken(token: string): { userId: string; sessionId: string; expiresAt: number } | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = accessSignature(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown; sid?: unknown; exp?: unknown };
    if (typeof parsed.sub !== 'string' || typeof parsed.sid !== 'string' || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return { userId: parsed.sub, sessionId: parsed.sid, expiresAt: parsed.exp };
  } catch { return null; }
}

export async function establishMobileSession(userId: string, userAgent?: string) {
  const refreshToken = randomToken(48);
  const familyId = randomToken(18);
  const session = await prisma.mobileSession.create({ data: { familyId, tokenHash: hashToken(refreshToken), userId, expiresAt: new Date(Date.now() + MOBILE_REFRESH_MS), userAgent } });
  return { accessToken: signMobileAccessToken(userId, session.id), refreshToken, expiresIn: Math.floor(MOBILE_ACCESS_MS / 1000) };
}

export async function rotateMobileSession(refreshToken: string, userAgent?: string) {
  const oldHash = hashToken(refreshToken);
  const old = await prisma.mobileSession.findUnique({ where: { tokenHash: oldHash }, include: { user: true } });
  if (!old) throw new HttpError(401, 'REFRESH_INVALID', 'The mobile session is invalid or expired.');
  if (old.revokedAt || old.replacedByHash) {
    await prisma.mobileSession.updateMany({ where: { familyId: old.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw new HttpError(401, 'REFRESH_REUSE_DETECTED', 'This mobile session was used more than once. Sign in again.');
  }
  if (old.expiresAt < new Date() || old.user.disabledAt) throw new HttpError(401, 'REFRESH_INVALID', 'The mobile session is invalid or expired.');
  const nextRaw = randomToken(48);
  const nextHash = hashToken(nextRaw);
  const next = await prisma.$transaction(async (tx) => {
    const created = await tx.mobileSession.create({ data: { familyId: old.familyId, tokenHash: nextHash, userId: old.userId, expiresAt: new Date(Date.now() + MOBILE_REFRESH_MS), userAgent: userAgent ?? old.userAgent } });
    await tx.mobileSession.update({ where: { id: old.id }, data: { revokedAt: new Date(), replacedByHash: nextHash, lastUsedAt: new Date() } });
    return created;
  });
  return { accessToken: signMobileAccessToken(old.userId, next.id), refreshToken: nextRaw, expiresIn: Math.floor(MOBILE_ACCESS_MS / 1000) };
}

export async function revokeMobileSession(refreshToken: string) {
  await prisma.mobileSession.updateMany({ where: { tokenHash: hashToken(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeSession(req: Request, res: Response) {
  if (req.sessionId) await prisma.session.update({ where: { id: req.sessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
  res.clearCookie(config.SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, path: '/' });
}

export async function issueEmailToken(userId: string, type: 'VERIFY_EMAIL' | 'RESET_PASSWORD', hours: number) {
  const raw = randomToken(32);
  await prisma.emailToken.create({ data: { userId, type, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + hours * 3_600_000) } });
  return raw;
}

/** Claim a token and its related mutation atomically, including under races. */
export async function consumeEmailToken<T>(rawToken: string, type: 'VERIFY_EMAIL' | 'RESET_PASSWORD', work: (tx: Prisma.TransactionClient, token: { id: string; userId: string }) => Promise<T>) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const token = await tx.emailToken.findFirst({ where: { tokenHash: hashToken(rawToken), type, usedAt: null, expiresAt: { gt: now } }, select: { id: true, userId: true } });
    if (!token) throw new HttpError(400, 'TOKEN_INVALID', 'This link is invalid or expired.');
    const claimed = await tx.emailToken.updateMany({ where: { id: token.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimed.count !== 1) throw new HttpError(400, 'TOKEN_INVALID', 'This link is invalid or expired.');
    return work(tx, token);
  });
}

export function validateRegistrationEmail(email: string) {
  if (!isEligibleEmail(email)) throw new HttpError(400, 'EMAIL_DOMAIN_NOT_ALLOWED', 'Registration is limited to an exact @iiitnr.edu.in address.');
  return normalizeEmail(email);
}

export function publicUser(user: NonNullable<Request['user']>) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, emailVerified: Boolean(user.emailVerifiedAt) };
}

export async function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}

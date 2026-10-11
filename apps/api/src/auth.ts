import argon2 from 'argon2';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './db.js';
import { HttpError } from './errors.js';
import { config } from './config.js';
import { hashToken, isEligibleEmail, normalizeEmail, randomToken } from './security.js';
import type { Role } from '@prisma/client';
import { roleRank } from './types.js';

export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = req.cookies?.[config.SESSION_COOKIE];
    if (!raw) return next();
    const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.disabledAt) return next();
    req.sessionId = session.id;
    req.user = { id: session.user.id, email: session.user.email, displayName: session.user.displayName, role: session.user.role, emailVerifiedAt: session.user.emailVerifiedAt, disabledAt: session.user.disabledAt };
    next();
  } catch (error) {
    next(error);
  }
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

export async function revokeSession(req: Request, res: Response) {
  if (req.sessionId) await prisma.session.update({ where: { id: req.sessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
  res.clearCookie(config.SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, path: '/' });
}

export async function issueEmailToken(userId: string, type: 'VERIFY_EMAIL' | 'RESET_PASSWORD', hours: number) {
  const raw = randomToken(32);
  await prisma.emailToken.create({ data: { userId, type, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + hours * 3_600_000) } });
  return raw;
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

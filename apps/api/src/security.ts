import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { HttpError } from './errors.js';

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(`${config.SESSION_SECRET}:${token}`).digest('hex');
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isEligibleEmail(email: string) {
  return /^[^\s@]+@iiitnr\.edu\.in$/i.test(normalizeEmail(email));
}

export function ensureCsrfCookie(req: Request, res: Response, next: NextFunction) {
  if (!req.cookies?.[config.CSRF_COOKIE]) {
    const token = randomToken(24);
    req.cookies[config.CSRF_COOKIE] = token;
    res.cookie(config.CSRF_COOKIE, token, {
      httpOnly: false,
      sameSite: 'lax',
      secure: config.COOKIE_SECURE,
      path: '/',
      maxAge: 86_400_000,
    });
  }
  next();
}

export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Exempt only authenticated bearer requests and cookie-free native auth.
  // A dummy Authorization header must not bypass protection for a cookie session.
  if (!req.sessionId && req.mobileSessionId) return next();
  if (!req.cookies?.[config.SESSION_COOKIE] && req.path.startsWith('/auth/mobile/')) return next();
  const origin = req.get('origin');
  if (origin && ![config.PUBLIC_ORIGIN, config.MANAGE_ORIGIN].includes(origin)) return next(new HttpError(403, 'ORIGIN_INVALID', 'Origin not allowed.'));
  const cookieToken = req.cookies?.[config.CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');
  if (typeof cookieToken !== 'string' || !headerToken || Buffer.byteLength(cookieToken) !== Buffer.byteLength(headerToken) || !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))) {
    return next(new HttpError(403, 'CSRF_REQUIRED', 'A valid CSRF token is required.'));
  }
  next();
}

import path from 'node:path';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

let repositoryRoot = process.env.SITE_ROOT || process.cwd();
while (!existsSync(path.join(repositoryRoot, 'index.html')) && repositoryRoot !== path.dirname(repositoryRoot)) repositoryRoot = path.dirname(repositoryRoot);
dotenv.config({ path: path.join(repositoryRoot, '.env'), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:8080'),
  MANAGE_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  PRIVATE_MEDIA_ROOT: z.string().default('./var/private-media'),
  PUBLIC_MEDIA_ROOT: z.string().default('./var/public-media'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(15_728_640),
  MAX_UPLOAD_FILES: z.coerce.number().int().positive().default(30),
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  MIN_IMAGE_WIDTH: z.coerce.number().int().positive().default(800),
  MIN_IMAGE_HEIGHT: z.coerce.number().int().positive().default(600),
  NEAR_DUPLICATE_HAMMING_DISTANCE: z.coerce.number().int().min(1).max(32).default(8),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().default('NSS IIIT Naya Raipur <nss@iiitnr.edu.in>'),
  MAIL_PREVIEW_BASE_URL: z.string().url().default('http://localhost:4000/api/v1/auth'),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

const root = repositoryRoot;
export const config = {
  ...parsed.data,
  PRIVATE_MEDIA_ROOT: path.resolve(root, parsed.data.PRIVATE_MEDIA_ROOT),
  PUBLIC_MEDIA_ROOT: path.resolve(root, parsed.data.PUBLIC_MEDIA_ROOT),
  SESSION_COOKIE: 'nss_session',
  CSRF_COOKIE: 'nss_csrf',
  SESSION_DAYS: 14,
  SITE_ROOT: root,
};

if (config.NODE_ENV === 'production' && (!config.COOKIE_SECURE || !config.PUBLIC_ORIGIN.startsWith('https:'))) throw new Error('Production requires HTTPS and COOKIE_SECURE=true');

export type Config = typeof config;

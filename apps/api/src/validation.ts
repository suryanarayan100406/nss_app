import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  q: z.string().trim().max(120).optional(),
});

export const registerSchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().trim().min(2).max(100),
  password: z.string().min(12).max(128),
});

export const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) });
export const tokenSchema = z.object({ token: z.string().min(20).max(300) });

export const eventSchema = z.object({
  title: z.string().trim().min(2).max(180),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180),
  summary: z.string().trim().max(500).default(''),
  description: z.string().trim().min(2).max(50_000),
  category: z.string().trim().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  coverMediaId: z.string().cuid().nullable().optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date().nullable().optional(),
  timezone: z.string().trim().min(1).max(80).default('Asia/Kolkata'),
  venue: z.string().trim().max(240).default(''),
  mapUrl: z.string().url().nullable().optional(),
  organizer: z.string().trim().max(240).default('NSS IIIT Naya Raipur'),
  collaboratingOrganizations: z.string().trim().max(500).default(''),
  coordinators: z.string().trim().max(500).default(''),
  registrationUrl: z.string().url().nullable().optional(),
  socialUrls: z.array(z.string().url()).max(10).default([]),
  reportUrl: z.string().url().nullable().optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ONGOING', 'COMPLETED', 'CANCELLED', 'ARCHIVED']).default('DRAFT'),
  visibility: z.enum(['PRIVATE', 'PUBLIC']).default('PRIVATE'),
  featured: z.boolean().default(false),
  displayOrder: z.number().int().min(0).default(0),
  uploadOpensAt: z.coerce.date().nullable().optional(),
  uploadClosesAt: z.coerce.date().nullable().optional(),
  academicYearId: z.string().cuid().nullable().optional(),
  seoTitle: z.string().trim().max(180).nullable().optional(),
  seoDescription: z.string().trim().max(320).nullable().optional(),
}).superRefine((event, ctx) => {
  if (event.endAt && event.endAt <= event.startAt) ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'End time must be after the start time.' });
  if (event.uploadOpensAt && event.uploadClosesAt && event.uploadClosesAt <= event.uploadOpensAt) ctx.addIssue({ code: 'custom', path: ['uploadClosesAt'], message: 'Upload closing time must be after opening time.' });
});

export const moderationSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(1000).optional(),
});

export const photoRemovalSchema = z.object({ reason: z.string().trim().min(3).max(1000) });

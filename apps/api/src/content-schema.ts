import { z } from 'zod';

// Public content is edited by named bindings only. Admins never submit HTML,
// CSS selectors, scripts, or arbitrary attributes to the renderer.
export const bindings = {
  'hero.motto': ['#heroMotto', 'text'], 'hero.title': ['#heroTitle', 'lines'], 'hero.body': ['#heroSub', 'text'], 'hero.image': ['#heroImg', 'src'], 'hero.alt': ['#heroImg', 'alt'], 'hero.primaryLabel': ['#heroActions .btn-primary', 'text'], 'hero.primaryUrl': ['#heroActions .btn-primary', 'href'], 'hero.secondaryLabel': ['#heroActions .btn-ghost', 'text'], 'hero.secondaryUrl': ['#heroActions .btn-ghost', 'href'],
  'about.title': ['#about .section-title', 'lines'], 'about.lead': ['#about .lead', 'text'], 'about.body': ['#about p[data-fade]', 'text'], 'about.image': ['#aboutDuo img', 'src'], 'about.alt': ['#aboutDuo img', 'alt'], 'about.caption': ['#aboutTag', 'text'],
  'director.name': ['.director-attr strong', 'text'], 'director.designation': ['.director-attr span', 'text'], 'director.text': ['#director .lead', 'text'], 'director.image': ['#director img', 'src'], 'director.alt': ['#director img', 'alt'],
  'join.title': ['#join .join-title', 'lines'], 'join.copy': ['#join .join-copy', 'text'], 'contact.email': ['.contact-box .email', 'email'], 'footer.note': ['.footer-note', 'text'], 'footer.copyright': ['.footer-bar > span', 'text'], 'credits.name': ['.dsn-plain', 'text'], 'credits.link': ['#dsnName', 'href'], 'credits.note': ['.dsn-note', 'text'], 'logos.nss': ['#emblem img', 'src'], 'logos.iiit': ['.emblem-iiit img, .footer-logo', 'src'], 'seo.title': ['title', 'text'], 'seo.description': ['meta[name="description"]', 'content'],
} as const;
export type BindingKey = keyof typeof bindings;
export const safeUrl = z.string().max(2000).refine((value) => /^(\/(?!\/)|#[\w-]|https?:\/\/|mailto:)/i.test(value) && !/[\r\n\\]/.test(value), 'Use a local /path, anchor, HTTP(S), or mailto URL.');
export const imageUrl = z.string().max(2000).refine((value) => /^\/(assets|media)\/[^<>]*$/.test(value) && !value.includes('..'), 'Choose an image from the local media library.');
const values = z.record(z.string(), z.string().max(20000)).superRefine((record, ctx) => { for (const [key, value] of Object.entries(record)) { if (!(key in bindings)) { ctx.addIssue({ code: 'custom', message: `Unknown field: ${key}` }); continue; } const kind = bindings[key as BindingKey][1]; const result = kind === 'src' ? imageUrl.safeParse(value) : kind === 'href' ? safeUrl.safeParse(value) : kind === 'email' ? z.string().email().safeParse(value) : null; if (result && !result.success) ctx.addIssue({ code: 'custom', message: `Invalid ${key}`, path: [key] }); } });
export const metricSchema = z.object({ number: z.number().int().min(0), label: z.string().min(1).max(200), suffix: z.string().max(30), progress: z.number().min(0).max(1).nullable(), visible: z.boolean() });
export const homepageSchema = z.object({ values, hiddenSections: z.array(z.enum(['top', 'about', 'impact', 'events', 'director', 'team', 'join', 'credits'])).default([]), metrics: z.array(metricSchema).max(30), navigation: z.array(z.object({ label: z.string().min(1).max(50), url: safeUrl })).max(14), socials: z.array(z.object({ label: z.string().min(1).max(40), url: safeUrl })).max(12), steps: z.array(z.object({ title: z.string().max(120), text: z.string().max(2000) })).max(12), mobileHero: imageUrl.or(z.literal('')).default(''), focalX: z.number().min(0).max(100).default(50), focalY: z.number().min(0).max(100).default(50), accent: z.enum(['marigold', 'moss', 'rust']).default('marigold'), visible: z.boolean().default(true), canonicalPath: z.string().regex(/^\/(?:index\.html)?$/).default('/'), shareImage: imageUrl.or(z.literal('')).default(''), favicon: imageUrl.or(z.literal('')).default('') });
export type Homepage = z.infer<typeof homepageSchema>;

const requiredValueKeys = ['hero.motto', 'hero.title', 'hero.body', 'hero.image', 'hero.primaryLabel', 'hero.primaryUrl', 'about.title', 'about.lead', 'about.body', 'director.name', 'director.designation', 'director.text', 'join.title', 'join.copy', 'contact.email', 'seo.title', 'seo.description'] as const;

export function parseHomepageContent(input: unknown) {
  const homepage = homepageSchema.parse(input);
  for (const key of requiredValueKeys) {
    if (!homepage.values[key]?.trim()) throw new z.ZodError([{ code: 'custom', path: ['values', key], message: `Homepage field ${key} is required.` }]);
  }
  return homepage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge editor patches into the last complete revision before validation. */
export function mergeHomepageContent(base: unknown, patch: unknown) {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) output[key] = isRecord(value) && isRecord(base[key]) ? mergeHomepageContent(base[key], value) : value;
  return output;
}

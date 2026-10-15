import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { load, type CheerioAPI } from 'cheerio';
import { prisma } from './db.js';
import { config } from './config.js';
import { attachUser } from './auth.js';
import { bindings, homepageSchema, parseHomepageContent, type Homepage, type BindingKey } from './content-schema.js';
import { publicEventDetailWhere } from './policy.js';
import { HttpError } from './errors.js';
import { publicPath } from './media.js';
import type { Event, EventStatus } from '@prisma/client';

export const siteRouter = express.Router();
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const mediaLink = (key: string | null) => key ? `/media/${key}` : '';
const eventLink = (e: { legacyPath: string | null; slug: string }) => e.legacyPath || `/event.html?slug=${encodeURIComponent(e.slug)}`;
const liveEventWhere = { visibility: 'PUBLIC' as const, deletedAt: null, status: { in: ['PUBLISHED', 'ONGOING', 'COMPLETED', 'CANCELLED'] as EventStatus[] } };
const date = (event: Event) => event.dateLabel || new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', ...(event.dateOnly ? {} : { timeStyle: 'short' }), timeZone: event.timezone }).format(event.startAt);
const include = { coverMedia: true, gallery: { where: { publishedAt: { not: null }, media: { status: 'PUBLIC' as const } }, include: { media: true }, orderBy: { displayOrder: 'asc' as const }, take: 100 }, participants: true } as const;

async function sendStaticFallback(file: string, res: express.Response) {
  const safe = path.resolve(config.SITE_ROOT, file);
  if (!safe.startsWith(`${config.SITE_ROOT}${path.sep}`)) throw new HttpError(404, 'NOT_FOUND', 'The requested page was not found.');
  res.set('Cache-Control', 'no-store').type('html').send(await fs.readFile(safe, 'utf8'));
}

function fallbackFile(requestPath: string) {
  if (requestPath === '/' || requestPath === '/index.html') return 'index.html';
  if (requestPath === '/team.html') return 'team.html';
  if (requestPath === '/event.html') return 'event.html';
  if (/^\/event(?:-[a-z-]+)?\.html$/.test(requestPath)) return requestPath.slice(1);
  return null;
}

function titleLines($: CheerioAPI, selector: string, value: string) {
  $(selector).html(value.split('\n').map((line) => `<span class="line"><span>${esc(line)}</span></span>`).join(''));
}
async function currentHome() {
  const rev = await prisma.siteRevision.findFirst({ where: { key: 'homepage', status: 'PUBLISHED' }, orderBy: { version: 'desc' } });
  if (!rev) throw new HttpError(503, 'IMPORT_REQUIRED', 'The content import has not run yet.');
  const [metrics, director] = await Promise.all([
    prisma.impactMetric.findMany({ orderBy: { displayOrder: 'asc' } }),
    prisma.directorMessage.findFirst({ where: { visible: true } }),
  ]);
  const parsed = parseHomepageContent(rev.content);
  const values = { ...parsed.values };
  if (director) {
    values['director.name'] = director.name;
    values['director.designation'] = director.designation;
    values['director.text'] = director.text;
  }
  return homepageSchema.parse({ ...parsed, values, metrics: metrics.length ? metrics.map(({ number, label, suffix, progress, visible }) => ({ number, label, suffix, progress, visible })) : parsed.metrics });
}
function globalContent($: CheerioAPI, home: Homepage, isHome: boolean) {
  for (const [key, value] of Object.entries(home.values)) {
    if (!isHome && !/^(logos|footer|contact)\./.test(key)) continue;
    const [selector, kind] = bindings[key as BindingKey];
    if (kind === 'lines') titleLines($, selector, value);
    else if (kind === 'text') $(selector).text(value);
    else if (kind === 'email') $(selector).text(value).attr('href', `mailto:${value}`);
    else $(selector).attr(kind, value);
  }
  $('#navLinks').html(home.navigation.map((link) => `<a data-nav href="${esc(link.url)}">${esc(link.label)}</a>`).join(''));
  $('.footer-links').html(home.navigation.map((link) => `<a href="${esc(link.url)}">${esc(link.label)}</a>`).join(''));
  $('.footer-links').append('<a href="/calendar.html">Calendar</a><a href="/archives.html">Archives</a><a href="/manage/">Contribute</a>');
  $('.footer-social, #socialRow').html(home.socials.map((link) => `<a href="${esc(link.url)}" aria-label="${esc(link.label)}">${esc(link.label)}</a>`).join(''));
  $('script[src="js/public-cms.js"]').remove();
  $('head').prepend('<base href="/">');
  if (home.favicon) $('head').append(`<link rel="icon" href="${esc(home.favicon)}">`);
}

type TeamCard = { category: string; html: string };
async function teamCards(featured: boolean): Promise<TeamCard[]> {
  const members = await prisma.teamMember.findMany({ where: { publicVisible: true, ...(featured ? { active: true, featured: true } : {}) }, orderBy: { displayOrder: 'asc' }, include: { category: true, photoMedia: true } });
  return members.map((m) => {
    const prefix = featured ? 'tf' : /Leadership/.test(m.category.name) ? 'tl' : 'tm';
    const cls = featured ? 'team-featured-card' : prefix === 'tl' ? 'team-leader-card' : 'team-member-card';
    return { category: m.category.name, html: `<div class="${cls}" style="--accent:var(--moss)"><div class="${prefix}-photo">${m.photoMedia?.publicKey ? `<img src="${mediaLink(m.photoMedia.publicKey)}" alt="${esc(m.fullName)}" loading="lazy">` : ''}<span class="${prefix}-initials">${esc(m.fullName.split(' ').map((p) => p[0]).join(''))}</span></div><h4>${esc(m.fullName)}</h4><p class="${prefix}-role">${esc(m.designation)}</p>${m.biography ? `<p>${esc(m.biography)}</p>` : ''}${m.showEmail && m.email ? `<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : ''}${m.showPhone && m.phone ? `<a href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : ''}</div>` };
  });
}

export async function renderHome(preview?: Homepage) {
  const home = preview || await currentHome();
  if (!home.visible && !preview) throw new HttpError(404, 'PAGE_UNPUBLISHED', 'This page is unpublished.');
  const $ = load(await fs.readFile(path.join(config.SITE_ROOT, 'index.html'), 'utf8'));
  globalContent($, home, true);
  home.hiddenSections.forEach((id) => $(`#${id}`).remove());
  $('.impact-row').html(home.metrics.filter((m) => m.visible).map((m) => `<div class="impact-item"><div class="impact-num"><span data-count="${m.number}">${m.number}</span><span class="suffix">${esc(m.suffix)}</span></div><p class="impact-label">${esc(m.label)}</p>${m.progress === null ? '' : `<div class="impact-bar"><span data-fill-bar="${m.progress}"></span></div>`}</div>`).join(''));
  $('#heroImg').attr('style', `object-position:${home.focalX}% ${home.focalY}%`);
  if (home.mobileHero) $('#heroImg').wrap('<picture></picture>').before(`<source media="(max-width:700px)" srcset="${esc(home.mobileHero)}">`);
  $('#joinSteps .step').remove();
  $('#joinSteps').append(home.steps.map((s, i) => `<div class="step"><span class="step-num">${String(i + 1).padStart(2, '0')}</span><div><h5>${esc(s.title)}</h5><p>${esc(s.text)}</p></div></div>`).join(''));
  const events = await prisma.event.findMany({ where: { ...liveEventWhere, featured: true }, orderBy: [{ displayOrder: 'asc' }, { startAt: 'desc' }], include: { coverMedia: true }, take: 100 });
  const originals = $('#eventsRail .event-card').toArray();
  $('#eventsRail').empty();
  for (const e of events) {
    const source = originals.find((node) => $(node).attr('data-event-url') === e.legacyPath?.slice(1));
    const card = source ? $(source) : $('<article class="event-card"><div class="ec-inner"><div class="media duo"><img><a class="media-hit"></a></div><div class="body"><p class="event-date"></p><h3><a></a></h3><p class="summary"></p></div></div></article>');
    card.find('h3 a').text(e.title).attr('href', eventLink(e));
    card.attr('data-template', eventLink(e)).attr('data-event-url', eventLink(e));
    card.find('.body > p').not('.event-date').first().text(e.summary);
    card.find('.event-date').text(`${date(e)} · ${e.category}`);
    card.find('a.media-hit').attr('href', eventLink(e));
    if (e.coverMedia?.publicKey) card.find('.media img').attr('src', mediaLink(e.coverMedia.publicKey)).attr('alt', e.coverMedia.altText);
    $('#eventsRail').append(card);
  }
  $('#teamMarqueeTrack').html((await teamCards(true)).map((m) => m.html).join('')).attr('data-ordered', 'true');
  $('head').append(`<link rel="canonical" href="${esc(config.PUBLIC_ORIGIN + home.canonicalPath)}"><meta property="og:title" content="${esc(home.values['seo.title'])}"><meta property="og:description" content="${esc(home.values['seo.description'])}">${home.shareImage ? `<meta property="og:image" content="${esc(config.PUBLIC_ORIGIN + home.shareImage)}">` : ''}`);
  return $.html();
}

siteRouter.use(attachUser);
siteRouter.get(['/','/index.html'], async (req, res, next) => { try {
  let preview: Homepage | undefined;
  if (req.query.preview) { if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Admin preview only.'); const rev = await prisma.siteRevision.findUniqueOrThrow({ where: { id: String(req.query.preview) } }); preview = homepageSchema.parse(rev.content); }
  res.set('Cache-Control', 'no-store').type('html').send(await renderHome(preview));
} catch (error) { if (error instanceof HttpError && error.status < 500) return next(error); const file = fallbackFile(req.path); if (file) { try { await sendStaticFallback(file, res); } catch (fallbackError) { next(fallbackError); } } else next(error); } });

siteRouter.get('/team.html', async (_req, res, next) => { try {
  const $ = load(await fs.readFile(path.join(config.SITE_ROOT, 'team.html'), 'utf8')); globalContent($, await currentHome(), false);
  const groups = new Map<string, TeamCard[]>();
  for (const card of await teamCards(false)) groups.set(card.category, [...(groups.get(card.category) || []), card]);
  $('.team-officer-spotlight,.team-leaders-grid,.team-core-grid,.team-volunteers-grid,.senior-core-grid').empty();
  const targets = { 'Leadership & Guidance': '.team-leaders-grid:not(.senior-leaders-grid)', 'Core Members': '.team-core-grid', 'Student Volunteers': '.team-volunteers-grid', 'Senior Batch · 2024': '.senior-core-grid' };
  for (const [category, cards] of groups) { const target = targets[category as keyof typeof targets]; if (target) $(target).html(cards.map((m) => m.html).join('')).attr('data-ordered', 'true'); else $('#main').append(`<section class="team-core"><div class="wrap"><h2 class="section-title">${esc(category)}</h2><div class="team-core-grid" data-ordered="true">${cards.map((m) => m.html).join('')}</div></div></section>`); }
  res.set('Cache-Control','no-store').type('html').send($.html());
} catch { try { await sendStaticFallback('team.html', res); } catch (fallbackError) { next(fallbackError); } } });

siteRouter.get(/^\/(?:event(?:-[a-z-]+)?\.html|events\/[a-z0-9-]+)$/, async (req, res, next) => { try {
  const preview = req.query.preview === '1' && req.user?.role === 'ADMIN';
   const event = await prisma.event.findFirst({ where: { ...(req.path === '/event.html' ? { slug: String(req.query.slug || '') } : req.path.startsWith('/events/') ? { slug: req.path.slice(8) } : { legacyPath: req.path === '/event-template.html' ? '/event-blood-donation.html' : req.path }), ...(preview ? { deletedAt: null } : publicEventDetailWhere) }, include });
  if (!event) throw new HttpError(404, 'EVENT_UNPUBLISHED', 'This event is not published.');
  const $ = load(await fs.readFile(path.join(config.SITE_ROOT, event.legacyPath?.slice(1) || 'event-template.html'), 'utf8'));
  globalContent($, await currentHome(), false);
  const sourceTitle = $('#heroTitle').text().replace(/\s+/g,' ').trim();
  if (!event.legacyPath || !sourceTitle.includes(event.title.replace(/\.$/,''))) titleLines($, '#heroTitle', event.title);
  $('#heroSub').text(event.summary); $('#heroMotto').text(`${date(event)} · ${event.category}`);
  $('.evp-meta li').eq(0).find('.v').text(event.venue); $('.evp-meta li').eq(1).find('.v').text(`${date(event)} · ${event.timezone}`);
  $('.evp-meta li').eq(3).find('.v').text(event.organizer);
  if (event.coverMedia?.publicKey) $('#heroImg').attr('src', mediaLink(event.coverMedia.publicKey)).attr('alt', event.coverMedia.altText);
  const paragraphs = event.description.split('\n\n'); $('#about .lead').text(paragraphs[0]); $('#about p[data-fade]').text(paragraphs.slice(1).join('\n\n'));
  if (!event.legacyPath) { $('#marqueeTrack span').text(event.title); titleLines($, '#about .section-title', 'About this event'); $('.about-media').remove(); titleLines($, '#gallery .section-title', 'Published photographs'); $('.evp-meta li').eq(2).remove(); $('#about .eyebrow').text(event.category); $('#participants h2').text('Participants & organizers'); }
  $('.evp-links').empty();
  for (const url of Array.isArray(event.socialUrls) ? event.socialUrls : []) if (typeof url === 'string' && /^https?:/.test(url)) $('.evp-links').append(`<a href="${esc(url)}" rel="noopener">Event link ↗</a>`);
   $('#heroActions').append(`<a class="btn-ghost" href="/manage/upload?event=${esc(event.id)}">Contribute photos</a><a class="btn-ghost" href="/api/v1/public/events/${esc(event.slug)}.ics">Download calendar</a>`);
  $('.evp-grid').html(event.gallery.map((item) => `<figure><img src="${mediaLink(item.media.publicKey)}" alt="${esc(item.altText || item.media.altText)}" loading="lazy"><figcaption>${esc(item.caption)}${item.credit ? ` · ${esc(item.credit)}` : ''}</figcaption></figure>`).join(''));
  $('#evpTable thead tr').html(['#','Name','Roll No.','Role / Category','Department','Year / Batch','Contribution','Status'].map((h) => `<th scope="col">${h}</th>`).join(''));
  $('#evpBody').html(event.participants.map((p, i) => `<tr data-attendance="${esc(p.attendance.toLowerCase())}">${[i+1,p.name,p.rollNo || '—',p.role,p.department,p.batch,p.contribution,p.attendance].map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join(''));
  $('title').text(`${event.seoTitle || event.title} — NSS IIIT Naya Raipur`); $('meta[name="description"]').attr('content', event.seoDescription || event.summary);
  $('head').append(`<link rel="canonical" href="${esc(config.PUBLIC_ORIGIN + eventLink(event))}"><meta property="og:title" content="${esc(event.title)}"><meta property="og:description" content="${esc(event.summary)}">${event.coverMedia?.publicKey ? `<meta property="og:image" content="${esc(config.PUBLIC_ORIGIN + mediaLink(event.coverMedia.publicKey))}">` : ''}`);
  res.set('Cache-Control','no-store').type('html').send($.html());
} catch (error) { if (error instanceof HttpError && error.status < 500) return next(error); const file = fallbackFile(req.path); if (file) { try { await sendStaticFallback(file, res); } catch (fallbackError) { next(fallbackError); } } else next(error); } });

// No filesystem static mount for derivatives: each request rechecks publication.
siteRouter.get('/media/*key', async (req, res, next) => { try {
  const key = Array.isArray(req.params.key) ? req.params.key.join('/') : req.params.key;
  const baseKey = String(key).replace('-thumb.webp', '.webp');
  const media = await prisma.mediaAsset.findFirst({ where: { publicKey: baseKey, status: 'PUBLIC' }, include: { submissions: { include: { event: true } } } });
   const hasPublicSubmission = media?.submissions.some((s) => ['PUBLISHED', 'REMOVAL_REQUESTED'].includes(s.status) && ['PUBLISHED', 'ONGOING', 'COMPLETED', 'ARCHIVED', 'CANCELLED'].includes(s.event.status) && s.event.visibility === 'PUBLIC' && !s.event.deletedAt);
   if (!media || (media.submissions.length > 0 && !hasPublicSubmission)) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Media is not published.');
  res.set('Cache-Control','no-store').type('image/webp').sendFile(publicPath(String(key)));
} catch (error) { next(error); } });
for (const folder of ['assets','css','js','vendor']) siteRouter.use(`/${folder}`, express.static(path.join(config.SITE_ROOT, folder), { index: false, dotfiles: 'deny' }));
siteRouter.get(['/calendar.html', '/archives.html', '/archive.html'], (req, res) => res.sendFile(path.join(config.SITE_ROOT, req.path.slice(1))));
siteRouter.use('/manage', express.static(path.join(config.SITE_ROOT, 'apps/admin-web/dist')));
siteRouter.get('/manage/*path', (_req,res) => res.sendFile(path.join(config.SITE_ROOT,'apps/admin-web/dist/index.html')));

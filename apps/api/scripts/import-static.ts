import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import sharp from 'sharp';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { bindings, homepageSchema } from '../src/content-schema.js';

export const legacyEvents = [
  ['event-walkathon.html', 'walkathon-26', '2026-09-27', null],
  ['event-plantation-drive.html', 'campus-wide-greenery-plantation-drive', '2025-09-27', '09:30'],
  ['event-blood-donation.html', 'blood-donation-camp-2025', '2025-11-01', '10:00'],
  ['event-cleanliness-drive.html', 'cleanliness-drive-2025', '2025-09-27', '08:30'],
  ['event-nukkad-natak.html', 'nukkad-natak-hiv-aids-awareness', '2025-10-16', '16:30'],
  ['event-sports-cricket.html', 'national-sports-day-cricket-2026', '2026-09-15', null],
  ['event-sports-football.html', 'national-sports-day-football-2026', '2026-08-29', null],
] as const;
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const key = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const local = (value: string) => value.startsWith('assets/') ? `/${value}` : value.startsWith('#') ? `/index.html${value}` : /^[a-z-]+\.html/.test(value) ? `/${value}` : value;

export async function registerLegacyMedia(src: string, altText = '') {
  const relative = src.replace(/^\//, '');
  if (!relative.startsWith('assets/')) return null;
  const existing = await prisma.mediaAsset.findUnique({ where: { storageKey: `legacy/${relative}` } });
  if (existing) return existing;
  const file = path.resolve(config.SITE_ROOT, relative);
  if (!file.startsWith(`${config.SITE_ROOT}${path.sep}`)) throw new Error('Unsafe source path');
  const bytes = await fs.readFile(file);
  const metadata = await sharp(bytes).metadata();
  // Retain originals untouched; re-encode the migrated public rendition.
  const publicKey = `legacy/${key(relative)}.webp`;
  await fs.mkdir(path.join(config.PUBLIC_MEDIA_ROOT, 'legacy'), { recursive: true });
  await sharp(bytes).rotate().resize({ width: 2400, withoutEnlargement: true }).webp({ quality: 86 }).toFile(path.join(config.PUBLIC_MEDIA_ROOT, publicKey));
  return prisma.mediaAsset.create({ data: { storageKey: `legacy/${relative}`, publicKey, originalName: relative, mimeType: 'image/webp', width: metadata.width, height: metadata.height, sizeBytes: bytes.length, sha256: key(bytes.toString('base64')), altText, status: 'PUBLIC', source: 'legacy' } });
}

export async function extractHomepage() {
  const $ = load(await fs.readFile(path.join(config.SITE_ROOT, 'index.html'), 'utf8'));
  const values: Record<string, string> = {};
  for (const [name, [selector, kind]] of Object.entries(bindings)) {
    const el = $(selector).first();
    values[name] = kind === 'src' || kind === 'href' ? local(el.attr(kind) || '') : kind === 'content' ? el.attr('content') || '' : kind === 'lines' ? el.find('.line').map((_i, line) => clean($(line).text())).get().join('\n') : clean(el.text());
  }
  return homepageSchema.parse({
    values, metrics: $('.impact-item').map((_i, el) => ({ number: Number($(el).find('[data-count]').attr('data-count')), label: clean($(el).find('.impact-label').text()), suffix: clean($(el).find('.suffix').text()), progress: Number($(el).find('[data-fill-bar]').attr('data-fill-bar')), visible: true })).get(),
    navigation: $('#navLinks a').map((_i, el) => ({ label: clean($(el).text()), url: local($(el).attr('href') || '') })).get(),
    socials: $('.footer-social a').map((_i, el) => ({ label: $(el).attr('aria-label') || '', url: $(el).attr('href') || '' })).get(),
    steps: $('.step').map((_i, el) => ({ title: clean($(el).find('h5').text()), text: clean($(el).find('p').text()) })).get(),
  });
}

export async function importStaticContent() {
  const home = load(await fs.readFile(path.join(config.SITE_ROOT, 'index.html'), 'utf8'));
  // No account records or assumed academic calendar are imported from public content.
  // Explicit years can be assigned later once the institutional rule is configured.
  for (const [order, [file, slug, date, time]] of legacyEvents.entries()) {
    if (await prisma.event.findUnique({ where: { slug } })) continue;
    const $ = load(await fs.readFile(path.join(config.SITE_ROOT, file), 'utf8'));
    const card = home(`.event-card[data-event-url="${file}"]`);
    const cover = await registerLegacyMedia($('#heroImg').attr('src') || '', $('#heroImg').attr('alt') || '');
    const meta = $('.evp-meta .v').map((_i, el) => clean($(el).text())).get();
    const event = await prisma.event.create({ data: {
      slug, legacyPath: `/${file}`, title: clean(card.find('h3').text()), summary: clean($('#heroSub').text()), description: $('.about-copy > p:not(.eyebrow)').map((_i, el) => clean($(el).text())).get().join('\n\n'),
      category: clean(card.find('.event-date').text()).split(' · ')[1] || 'NSS', tags: [], startAt: new Date(`${date}T${time || '00:00'}:00+05:30`), dateOnly: !time, dateLabel: meta[1], timezone: 'Asia/Kolkata', venue: meta[0] || '', organizer: meta[3] || '', collaboratingOrganizations: meta[3] || '', coordinators: '', coverMediaId: cover?.id, socialUrls: $('.evp-links a').map((_i, el) => $(el).attr('href')!).get(), status: 'PUBLISHED', visibility: 'PUBLIC', publicAt: new Date(), featured: true, displayOrder: order,
    } });
    for (const [index, figure] of $('#gallery figure').toArray().entries()) {
      const img = $(figure).find('img'); const media = await registerLegacyMedia(img.attr('src') || '', img.attr('alt') || '');
      if (media) await prisma.eventGalleryItem.upsert({ where: { eventId_mediaId: { eventId: event.id, mediaId: media.id } }, update: {}, create: { eventId: event.id, mediaId: media.id, caption: clean($(figure).find('figcaption').text()), altText: img.attr('alt') || '', displayOrder: index, publishedAt: new Date() } });
    }
    const hasRoll = $('#evpTable th').text().includes('Roll No');
    for (const [index, row] of $('#evpBody tr').toArray().entries()) {
      const cells = $(row).find('td').map((_i, cell) => clean($(cell).text())).get().slice(1);
      const offset = hasRoll ? 1 : 0;
      await prisma.eventParticipant.create({ data: { eventId: event.id, sourceKey: `${file}:${index}`, name: cells[0], rollNo: hasRoll ? cells[1] : null, role: cells[1 + offset] || '', department: cells[2 + offset] || '', batch: cells[3 + offset] || '', contribution: cells[4 + offset] || '', attendance: cells[5 + offset] || 'Present' } });
    }
  }
  const $ = load(await fs.readFile(path.join(config.SITE_ROOT, 'team.html'), 'utf8'));
  const featuredNames = new Set(home('.team-featured-card h4').map((_i, el) => clean(home(el).text())).get());
  for (const [order, card] of $('.team-leader-card, .team-member-card').toArray().entries()) {
    const node = $(card); const name = clean(node.find('h3,h4').first().text()); const sourceKey = key(`team:${name}`);
    if (await prisma.teamMember.findUnique({ where: { sourceKey } })) continue;
    const designation = clean(node.find('.tl-role,.tm-role').text()); const senior = node.closest('#team-seniors').length > 0;
    const categoryName = senior ? 'Senior Batch · 2024' : node.closest('#team-volunteers').length ? 'Student Volunteers' : node.closest('.team-core').length ? 'Core Members' : 'Leadership & Guidance';
    const category = await prisma.teamCategory.upsert({ where: { name: categoryName }, update: {}, create: { name: categoryName, slug: categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-') } });
    const photo = await registerLegacyMedia(node.find('img').attr('src') || '', name);
    await prisma.teamMember.create({ data: { sourceKey, fullName: name, designation, categoryId: category.id, photoMediaId: photo?.id, batchYear: senior ? '2024' : null, active: !senior, publicVisible: true, featured: featuredNames.has(name), displayOrder: order,
      // Preserve existing public contact records privately; re-publication needs explicit opt-in.
      email: node.find('a[href^="mailto:"]').attr('href')?.slice(7), phone: node.find('a[href^="tel:"]').attr('href')?.slice(4), showEmail: false, showPhone: false,
    } });
  }
  if (!await prisma.siteRevision.findFirst({ where: { key: 'homepage' } })) {
    const content = await extractHomepage();
    await prisma.siteRevision.create({ data: { key: 'homepage', version: 1, status: 'PUBLISHED', content, publishedAt: new Date() } });
    for (const [displayOrder, metric] of content.metrics.entries()) await prisma.impactMetric.create({ data: { ...metric, displayOrder } });
    await prisma.directorMessage.create({ data: { name: content.values['director.name'], designation: content.values['director.designation'], text: content.values['director.text'] } });
  }
  await prisma.siteSetting.upsert({ where: { key: 'academicYear.rule' }, update: {}, create: { key: 'academicYear.rule', value: { configured: false, message: 'Set the institutional start month/day before automatic assignment.' } } });
}

if (process.argv[1]?.endsWith('import-static.ts')) importStaticContent().then(() => console.log('Trusted content imported; existing CMS edits preserved.')).finally(() => prisma.$disconnect());

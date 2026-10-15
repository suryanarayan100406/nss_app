# NSS IIIT Naya Raipur: repository audit and migration map

Baseline audit performed before application changes on 2026-10-10. Follow-up
release-blocker audit and repair pass performed on 2026-10-12.

## Current repository

The supplied public source was a handcrafted, dependency-free static website.
The repository now contains the preserved source plus the TypeScript workspace,
PostgreSQL/Prisma API, worker, management web app, and native Flutter Android
client described below.

| Area | Current state | Migration treatment |
| --- | --- | --- |
| Public pages | `index.html`, `team.html`, seven event pages, and `event-template.html` | Keep every existing file and URL. Add a data-driven `event.html?slug=` route for new events and progressive API hydration with static fallback. |
| Design | `css/style.css` (~large shared stylesheet), Fraunces + Work Sans, paper/pine/marigold/rust palette | Reuse the stylesheet, bundled fonts, GSAP, ScrollTrigger, DrawSVGPlugin, Lenis, reduced-motion path, and existing motion primitives. The management app uses matching tokens without changing the public visual language. |
| Public runtime | `js/main.js` is an IIFE for loader, smooth scrolling, nav, reveals, rail, team, lightboxes, and Instagram modal | Preserve it. Add `js/public-cms.js` as a progressive enhancement layer which never prevents the static page from rendering when the API is unavailable. |
| Media | 130 local raster images, bundled fonts, bundled libraries, one report DOCX | Register trusted legacy files as imported/published media. Copy new/private uploads to a separate filesystem volume; only derivatives are public. |
| Events | Seven public event URLs plus a blood donation template; event cards and event pages duplicate content | Import each page into one normalized event record, preserve legacy URL aliases, and use the database for new cards/pages/calendar entries. Existing HTML remains a no-404 fallback during cutover. |
| Team | Current leadership, core members, volunteers, and a 2024 senior roster are embedded in `team.html` and featured cards in `index.html` | Import one team-member store with academic-year roster history. Public contact fields default to private even where the legacy page currently contains them. |
| Tables | Event pages contain organizer/participant tables with searchable/sortable client-side behavior. Walkathon has the largest table. | Import table rows into normalized event participant records using the idempotent static importer. Keep the old table in the legacy page until the data-driven event view is selected. |
| Forms | No registration, account, upload, moderation, or admin forms | Add these to the API and React management application; all server-validated. |
| Social links | NSS Instagram, X, IIIT website, and `nss@iiitnr.edu.in` appear repeatedly | Seed into site settings and render through the public hydration layer. |

## Content inventory

### Homepage

- Motto: `Not Me, But You`.
- Hero: `assets/images/_DSC0704.JPG`, fallback illustrated landscape, title `Service, built into / student life at IIIT NR.`, and the existing two CTAs.
- About copy and plantation image use `_DSC0704.JPG`.
- Impact has four current editable metrics: 150+ registered volunteers, 50+ saplings planted on and around campus, 5+ drives/camps this year, and 500+ volunteering hours.
- Director message: Prof. (Dr.) Om Prakash Vyas, Director, IIIT Naya Raipur, portrait `assets/images/director.jpg`.
- Seven event cards: Walkathon ’26, Campus-Wide Greenery & Plantation Drive, Blood Donation Camp 2025, Cleanliness Drive 2025, The Nukkad Natak, National Sports Day—Cricket, National Sports Day—Football.
- Featured team strip includes Mallikharjuna Rao K, Aditya Bhagat, Rabina Dahariya, and current core members.
- Join section has three steps, NSS Instagram/X/email, and contact address.
- Footer includes IIIT logo, navigation, motto, copyright, social links, and design credit for Surya Narayan.

### Legacy event records

| Legacy URL | Stable slug | Source media family | Date shown in source | Imported public route |
| --- | --- | --- | --- | --- |
| `event-walkathon.html` | `walkathon-26` | `assets/events/walkathon/` | 2026-09-27 | `/event.html?slug=walkathon-26` plus legacy file |
| `event-plantation-drive.html` | `campus-wide-greenery-plantation-drive` | `assets/events/plantation/` and `_DSC0704.JPG` | 2025-09-27 | `/event.html?slug=campus-wide-greenery-plantation-drive` plus legacy file |
| `event-blood-donation.html` | `blood-donation-camp-2025` | `assets/events/blood/` | 2025-11-01 | `/event.html?slug=blood-donation-camp-2025` plus legacy file |
| `event-cleanliness-drive.html` | `cleanliness-drive-2025` | `assets/events/cleanliness/` | 2025-09-27 | `/event.html?slug=cleanliness-drive-2025` plus legacy file |
| `event-nukkad-natak.html` | `nukkad-natak-hiv-aids-awareness` | `assets/events/nukkadnatak/` | 2025-10-16 | `/event.html?slug=nukkad-natak-hiv-aids-awareness` plus legacy file |
| `event-sports-cricket.html` | `national-sports-day-cricket-2026` | `assets/events/sports-cricket/` and `sports-cricket.jpg` | 2026-09-15 | `/event.html?slug=national-sports-day-cricket-2026` plus legacy file |
| `event-sports-football.html` | `national-sports-day-football-2026` | `assets/events/sports-football/` and `sports-football.jpg` | 2026-08-29 | `/event.html?slug=national-sports-day-football-2026` plus legacy file |

`event-template.html` is a blood-donation-derived authoring template, not an additional event. It is retained as source material and excluded from the imported public event count.

Each event page also contains a story lead/body, location/date metadata, organizer/collaborator text, a gallery with captions, a report/Instagram link where present, and an event-specific organizer/participant table. The importer reads those fields and rows from the source HTML so it does not invent missing data.

### Media inventory

- `assets/images/`: NSS and IIIT logos, director portrait, plantation hero, and placeholder instructions.
- `assets/images/team/`: 18 current leadership/core photos plus 4 senior-roster photos under `team/senior/`.
- `assets/events/`: event card photos, 102 event/gallery raster files, and `NSS.Report (1).docx`.
- `assets/fonts/`: Fraunces normal/italic and Work Sans variable WOFF2 files.
- `vendor/`: GSAP, ScrollTrigger, DrawSVGPlugin, Lenis.

The image inspection found existing EXIF/GPS metadata on some trusted source photographs. Imported historical media keeps the source file reference for visual continuity; public derivatives created by the upload pipeline are re-encoded and stripped of metadata.

## Migration map

| Existing source | New model/field | Notes |
| --- | --- | --- |
| `index.html` hero title/motto/paragraph/CTA | `SiteRevision` JSON sections `hero` | Published revisions only hydrate public DOM. |
| `index.html` about section | `SiteRevision.sections.about` | Image becomes a `MediaAsset` reference. |
| `data-count`, labels, suffix, `data-fill-bar` | `ImpactMetric` | Ordering and visibility are database fields. |
| Director block | `DirectorMessage` | Portrait references `MediaAsset`; no hardcoded replacement. |
| event card articles | `Event` + `EventCard` fields | One event record drives cards, calendar, archive, and detail. |
| event page hero/story/gallery | `Event` + `EventGalleryItem` | Gallery media is marked trusted/published on import. |
| event page `<table>` rows | `EventParticipant` | Imported idempotently using source URL/event/name/role key. |
| `team.html` cards and senior section | `TeamCategory`, `TeamMember`, `RosterMembership` | Current and 2024 academic rosters are retained. |
| navigation/footer/social links | `SiteSetting` namespaced keys | Safe text/URL validation, no arbitrary HTML/CSS. |
| local trusted photographs | `MediaAsset` with `source=legacy`, `visibility=public` | Original asset path stays available as a compatibility fallback. |
| new student uploads | `PhotoSubmission` + private `MediaAsset` | SHA-256 and dHash are persisted; public only after approval and event publication. |
| moderation decisions | `ModerationDecision`, `AuditLog`, `Notification` | Self-approval is denied in the service policy. |

## Architecture decision

Use a small TypeScript monorepo with:

1. An Express API (`apps/api`) using PostgreSQL through Prisma migrations, Zod request schemas, Argon2id passwords, database-backed sessions, HttpOnly cookies, CSRF double-submit tokens, Helmet, rate limiting, and structured JSON logs.
2. A Vite React/TypeScript management app (`apps/admin-web`) served at `/manage/` in production and port 5173 in development. It has shared authenticated shell, role-aware navigation, dashboard, event/calendar, upload, moderation, content, team, archive, audit, and settings views.
3. A persistent worker (`apps/api/src/worker.ts`) that claims due `ScheduledJob` rows with a database lock, performs idempotent publication, retries failures, and survives restarts.
4. Local filesystem storage under a configurable private root outside the public web root. Sharp generates JPEG/WebP derivatives and deterministic dHash/blur/resolution warnings. Public media is served from a controlled route after publication.
5. A native Flutter Android client in `apps/mobile/` uses short-lived bearer access tokens, rotating hashed refresh sessions, Riverpod, go_router, Dio, image_picker, secure storage, cached thumbnails, and background_downloader. It consumes the same API and role rules as the web client.
6. The existing static site stays in the repository and remains the visual source of truth. `public-cms.js` progressively hydrates homepage/team/event data and leaves static content available if the API is down. `event.html` is the dynamic template for new database events.

PostgreSQL is intentionally internal to Compose/production networking. Nginx is documented as an additive reverse-proxy snippet so existing host sites are backed up and untouched.

## Main risks and mitigations

- **Legacy duplicated content:** import and public hydration both use stable slugs and immutable source references; old files remain as fallback.
- **Private student information in old HTML:** imported contact fields are opt-in; the new public renderer omits them. The legacy team template is updated to avoid exposing contacts during the cutover.
- **Untrusted images:** uploads are streamed to a private temporary file, checked by signature and sharp decode, re-encoded, hashed, and stored with random names.
- **Moderation leaks:** public queries filter event publication and `PUBLISHED` submission state; private preview endpoints require an approver/admin and never expose raw paths.
- **Scheduler restart loss:** jobs are persistent rows with retry/lease fields, not timers.
- **No Docker/Flutter/Android tools in the current WSL session:** Node API/web checks and the embedded PostgreSQL integration runner run locally. Compose, Mailpit, Flutter package resolution, emulator/device checks, and APK generation remain explicitly environment-dependent checks.

## Implementation milestones

1. Add repository workspace, API schema/migrations/seed, auth, and deterministic media services.
2. Add public API, scheduler, event/team/content/admin routes, and dynamic public template/hydration.
3. Add responsive management app with real API flows, upload progress, moderation, calendar, archives, and role-aware controls.
4. Add Compose, Nginx, backup/restore, deployment/operations docs and migration checks.
5. Add the mobile client and run unit/type/lint/build checks, then run database/integration/browser/device suites when the corresponding services and SDKs are available.

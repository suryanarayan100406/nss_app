# NSS IIIT Naya Raipur platform operations

The repository now contains the preserved static public source plus a TypeScript/PostgreSQL CMS and community-photo workflow.

## Local development

Prerequisites: Node.js 24 (Node 20+ is supported), npm 11, Docker Desktop with WSL2 integration or a Linux Docker Engine. Docker is the reproducible path because it supplies PostgreSQL and Mailpit.

```bash
cp .env.example .env
npm install
docker compose -f compose.yml up --build
```

Open:

- Public site: http://localhost:8080
- Management app: http://localhost:5173
- API health: http://localhost:4000/health
- API readiness: http://localhost:4000/ready
- Mailpit inbox: http://localhost:8025
- New database event template: http://localhost:8080/event.html?slug=...
- Calendar: http://localhost:8080/calendar.html
- Academic archives: http://localhost:8080/archives.html

The development Compose stack keeps PostgreSQL internal, uses named volumes, stores private/public media in the `media-data` volume, and sends mail to Mailpit. The root directory remains mounted so edits are reflected by the API, public site, and Vite app.

Useful commands:

```bash
docker compose -f compose.yml down                 # stop, retain volumes
docker compose -f compose.yml down -v              # reset local DB/media (destructive)
docker compose -f compose.yml exec api npm run db:migrate   # apply committed Prisma migrations
docker compose -f compose.yml exec api npm run db:seed      # idempotent import of supplied static content
docker compose -f compose.yml exec api npm run db:admin     # interactive first-admin bootstrap
docker compose -f compose.yml exec api npm run import:static # repeat only the trusted content import
npm run lint && npm run typecheck && npm test
npm run build                                       # API + management production builds
npm --workspace apps/api run test:integration        # isolated embedded PostgreSQL + SSR checks
npm run test:e2e                                    # requires Playwright browsers
docker compose -f compose.yml logs -f api worker    # inspect API/scheduler logs
```

For a local demo account, pass `SEED_DEMO_PASSWORD` only to the seed command: `docker compose -f compose.yml exec -e SEED_DEMO_PASSWORD='local-only-long-password' api npm run db:seed`. This creates `demo.student@iiitnr.edu.in` and `demo.approver@iiitnr.edu.in` as verified local-only accounts. No demo password or student data is stored in the repository.

## Authentication and roles

Registration accepts only the exact case-insensitive domain `iiitnr.edu.in`; the server uses a boundary-aware regular expression and does not trust the browser. Verification and password reset tokens are hashed in the database. Sessions use random HttpOnly cookies, SameSite=Lax, a server-side session row, Argon2id password hashes, CSRF double-submit protection, Helmet, rate limiting, and audit entries for logins and sensitive operations.

Create the first admin after the database is ready:

```bash
docker compose -f compose.yml exec -e ADMIN_EMAIL=admin@iiitnr.edu.in -e ADMIN_NAME="NSS Administrator" -e ADMIN_PASSWORD='use-a-long-unique-password' api npm run db:admin
```

The command marks the account verified for bootstrap and is idempotent. It does not ship a production credential. Admins assign `APPROVER` or `ADMIN` in **Settings & audit**; users cannot escalate themselves, and approvers cannot decide on their own photo.

## Photo workflow test

1. Register a local `@iiitnr.edu.in` address, open the verification URL from Mailpit, and sign in.
2. As an admin, create an event in **Events** and publish it. New events default to an upload window opening immediately and closing 30 days after the event/end date; the versioned API accepts explicit `uploadOpensAt` and `uploadClosesAt` values for institutional scheduling. Open **Contribute photos**, select the published event, choose multiple JPEG/PNG/WebP images, accept the permission confirmation, and upload. Each file is processed separately and may succeed while another fails.
3. Watch the contribution status in **My contributions**. Originals are private; exact SHA-256 duplicates are blocked for that event. dHash near matches and deterministic low-resolution/aspect-ratio/softness checks become warnings.
4. Sign in as the approver account. Open **Review queue**, inspect a large private preview, warning context, and uploader. Rejecting requires a reason; approving your own item is server-denied.
5. Approve one photo while its event is published. The worker/public-media path creates a rotated, resized WebP derivative with metadata removed and the gallery API lists it immediately. Approve a photo against a draft/scheduled event to verify it remains `APPROVED` and private until event publication.
6. Submit an exact duplicate, malformed file, unsupported extension/content, oversized image, and a small image to verify the actionable per-file responses. The unit tests cover these deterministic checks.

Upload defaults are 15 MiB per file, 30 files per batch, 40 million pixels, and a recommended 800×600 minimum. Change them in `.env` or production environment configuration. The API limits multipart processing and never holds the full batch in memory.

## Calendar, scheduling, and archives

- `/calendar.html` provides a public month agenda and links to each stable event route. `/manage/calendar` adds month and agenda views for signed-in users.
- Each event stores its timezone explicitly and defaults to `Asia/Kolkata`. The API exposes `GET /api/v1/public/events/:slug.ics` for personal calendar import.
- Admin event publishing is idempotent. Schedule with `POST /api/v1/admin/events/:id/schedule` or the management event controls. The worker claims persistent `ScheduledJob` rows, retries failures with backoff, and continues after restarts.
- For a fast scheduler test, create a schedule a few minutes in the future and watch `docker compose logs -f worker`. For a database-level restart test, stop/start the worker before the due time; the job row remains pending.
- `/archives.html` lists published academic years and `/archive.html?year=2025-26` shows public events and galleries. Old data is not deleted during rollover.

## Public compatibility and migration

The original `index.html`, `team.html`, seven `event-*.html` URLs, supplied images, fonts, and bundled animation libraries remain in place. `js/public-cms.js` progressively hydrates the homepage/team/legacy event pages and quietly falls back to their authored content when the API is unreachable. New event records use `event.html?slug=...`; no new HTML file is required.

Run the importer repeatedly without duplicate events, team members, galleries, or participant rows:

```bash
docker compose -f compose.yml exec api npm run import:static
```

The complete mapping and source inventory are in `AUDIT.md`. Trusted supplied photographs are registered as published legacy media and are not sent through the student moderation queue.

## Production deployment on Ubuntu 24.04.1 LTS

The recommended topology is Docker Compose for PostgreSQL/API/worker plus the existing host Nginx. It binds PostgreSQL internally and binds the API only to `127.0.0.1:4000`. Do not replace existing sites or copy the snippet over the complete Nginx configuration.

1. Back up the current host configuration and choose a dedicated application directory:

   ```bash
   sudo cp -a /etc/nginx /etc/nginx.backup.$(date -u +%Y%m%dT%H%M%SZ)
   sudo mkdir -p /srv/nss-app /var/lib/nss-postgres /var/lib/nss-media/private-media /var/lib/nss-media/public-media
   sudo chown -R "$USER":"$USER" /srv/nss-app /var/lib/nss-media
   git clone <private-repository-url> /srv/nss-app
   cd /srv/nss-app
   cp .env.example .env.production
   chmod 600 .env.production
   ```

2. Set strong random `SESSION_SECRET`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and `DATABASE_URL` using the internal `db` hostname (for example `postgresql://nss:CHANGE_ME@db:5432/nss?schema=public`), plus `PUBLIC_ORIGIN`, `MANAGE_ORIGIN`, exact SMTP values, and the production media roots in `/srv/nss-app/.env.production`. Never commit this file. Ensure `/var/lib/nss-media/private-media` is not under the Nginx document root and is not world-readable.

3. Start the production services using the committed topology:

   ```bash
   docker compose --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml up -d --build
   docker compose --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml exec api npm run db:migrate
   docker compose --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml exec api npm run db:admin
   ```

4. Publish the additive Nginx site config. Copy `deploy/nginx/production-snippet.conf` to `/etc/nginx/sites-available/nss-iiitnr`, replace `nss.example.edu.in`, and keep the retained public files at `/srv/nss-app`. Build the management app and copy its output:

   ```bash
   npm run build:web
   sudo mkdir -p /srv/nss-app/apps/admin-web/dist
   sudo cp -a apps/admin-web/dist/. /srv/nss-app/apps/admin-web/dist/
   sudo ln -s /etc/nginx/sites-available/nss-iiitnr /etc/nginx/sites-enabled/nss-iiitnr
   sudo nginx -t
   sudo systemctl reload nginx
   ```

   Keep unrelated enabled sites intact. Add TLS with the institution's existing certificate process or `sudo certbot --nginx -d nss.example.edu.in` only after verifying the new HTTP server block. Redirect HTTP to HTTPS after certificate issuance and set `COOKIE_SECURE=true`.

5. Set ownership and permissions so the deployment user can operate the Compose services, the private media directory is `0700`/`0750`, and public derivatives are readable by the API/Nginx path. Do not expose ports 5432, 4000, or internal worker services through the firewall. Allow only SSH, 80, and 443 as appropriate. Configure unattended security updates and monitor disk usage of `/var/lib/nss-media` and `/var/lib/nss-postgres`.

6. Check deployment:

   ```bash
   curl -fsS http://127.0.0.1:4000/health
   docker compose --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml ps
   docker compose --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml logs --tail=100 api worker
   sudo nginx -t
   ```

Deployment rollback: keep the previous application checkout, run its committed migrations only if compatible, switch the symlink back, rebuild/restart the previous API image, and reload Nginx. Never run a destructive database reset during deployment.

## Backups and restore

`scripts/backup.sh` creates a PostgreSQL custom dump, a compressed private/public media archive, and SHA-256 checksums. It expects the Compose DB container name or `POSTGRES_CONTAINER` override:

```bash
POSTGRES_CONTAINER=nss-db-1 POSTGRES_USER=nss POSTGRES_DB=nss MEDIA_ROOT=/var/lib/nss-media ./scripts/backup.sh /var/backups/nss
```

Use an external encrypted backup destination and a systemd timer/cron entry after reviewing retention. Test restore in an isolated VM or clean local Compose project, never over live data first:

```bash
RESTORE_CONFIRM=YES POSTGRES_CONTAINER=nss-db-1 POSTGRES_USER=nss POSTGRES_DB=nss MEDIA_ROOT=/var/lib/nss-media ./scripts/restore.sh /var/backups/nss/20261010T120000Z
docker compose --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml exec api npm run db:migrate
```

The restore script verifies checksums and requires an explicit confirmation. Database records and private/public media are restored together; public cache headers are short enough to avoid retaining an unpublished listing for long, and removed media is no longer returned by public queries.

## Verification status in this environment

Passed locally: Prisma schema validation and migrations, API and management TypeScript checks, both ESLint runs, API and management production builds, 10 unit tests covering domain email policy, role ordering, academic-year/publication/self-review policy, exact/near image hashes, corrupted/unsupported files, and low-resolution warnings, the isolated embedded-PostgreSQL migration/import/API/SSR integration runner, 12 Playwright public/management smoke journeys, `bash -n` backup/restore script validation, and `npm audit --omit=dev --audit-level=high` with 0 vulnerabilities. Docker Compose startup, Mailpit delivery, and an actual Docker-volume backup/restore run remain deployment-environment checks because this WSL session has no Docker daemon; run `docker compose -f compose.yml up --build` on Docker Desktop/Linux before production deployment.

# NSS IIIT Naya Raipur — Application Build and Run Guide

This guide explains how to install the required tools, start the complete local
platform, build the API and web application, run the native Flutter Android
client, test the system, and troubleshoot common setup problems.

The repository contains four related pieces:

1. **Preserved public website** — static HTML, CSS, JavaScript, bundled fonts,
   GSAP/ScrollTrigger, DrawSVGPlugin, Lenis, images, and legacy event URLs.
2. **TypeScript API** — Express, Zod, Prisma, PostgreSQL, Sharp, Argon2id,
   cookie sessions, mobile bearer authentication, moderation, media processing,
   and versioned routes under `/api/v1`.
3. **Responsive management web application** — React, TypeScript, Vite,
   React Router, and Lucide React.
4. **Native Android application** — Flutter under `apps/mobile/`. It uses the
   same API and account system; it is not a WebView wrapper.

Production deployment is intentionally not performed by this guide. The
Ubuntu deployment instructions are included for an operator to review and run
manually in `PLATFORM.md`.

---

## 1. Recommended development layout

The easiest supported setup on Windows is:

- Windows 10/11 host.
- Docker Desktop with WSL2 integration enabled.
- Ubuntu 24.04 or another supported WSL2 Linux distribution for repository
  commands.
- Node.js 24 and npm 11 in WSL, or use the Docker-based Node toolchain.
- Flutter stable and Android Studio installed on Windows for Android builds.
- The repository checked out in a path accessible from WSL, for example:

```text
/mnt/c/Users/<your-windows-user>/Desktop/nss_app
```

Linux users may install Docker Engine, Node.js, Flutter, and Android Studio
directly on Linux instead.

Do not place passwords, SMTP credentials, signing keys, APK keystores, or
production `.env` files in Git.

---

## 2. Get the source code

Open Ubuntu/WSL and clone or enter the repository:

```bash
git clone <repository-url> ~/nss_app
cd ~/nss_app
```

If the repository is already on the Windows desktop:

```bash
cd /mnt/c/Users/<your-windows-user>/Desktop/nss_app
```

Confirm that the expected files exist:

```bash
pwd
ls
test -f package.json
test -f compose.yml
test -f apps/mobile/pubspec.yaml
```

The application root is the directory containing the root `package.json` and
`compose.yml`. Run root-level npm commands from that directory.

---

## 3. Install and verify Node.js

The repository supports Node.js 20 or newer and is developed/tested with Node
24. Use Node 24 when possible.

Verify the installation:

```bash
node --version
npm --version
```

Recommended output is approximately:

```text
v24.x.x
11.x.x
```

If Node is missing on Ubuntu/WSL, install it with a version manager such as
`nvm`, then reopen the shell:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 24
nvm use 24
nvm alias default 24
node --version
npm --version
```

Do not install dependencies globally. The project uses the root lockfile and
workspace packages.

Install JavaScript dependencies:

```bash
npm install
```

This installs the root workspace dependencies for:

- `apps/api`
- `apps/admin-web`
- Prisma tooling
- Playwright tooling
- embedded PostgreSQL integration tests

---

## 4. Install Docker Desktop and enable WSL2 integration

Docker is the reproducible local path because it supplies PostgreSQL, Mailpit,
the API, worker, Nginx, and the Vite management application.

### Windows setup

1. Install Docker Desktop from the official Docker website.
2. Start Docker Desktop.
3. In **Settings → General**, keep the WSL2-based engine enabled.
4. In **Settings → Resources → WSL Integration**, enable the Ubuntu
   distribution containing this repository.
5. Restart the WSL terminal after changing the integration setting.

Verify from WSL:

```bash
docker --version
docker compose version
docker info
```

`docker info` must show a running Docker server. If it only shows client
information or says that the Docker daemon cannot be reached, start Docker
Desktop and enable WSL integration.

If the Docker command is unavailable inside WSL but Docker Desktop is
installed, restart Docker Desktop and verify the distribution under **WSL
Integration**. Do not copy Docker socket files manually.

---

## 5. Create the local environment file

Create a local environment file from the redacted template:

```bash
cp .env.example .env
chmod 600 .env
```

For normal local Compose development, the defaults are usable. At minimum,
replace `SESSION_SECRET` with a random local-only value:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Put the generated value into `.env`:

```dotenv
SESSION_SECRET=replace-with-the-generated-local-value
```

Important local variables:

| Variable | Local purpose |
|---|---|
| `PUBLIC_ORIGIN` | Public site origin, normally `http://localhost:8080` |
| `MANAGE_ORIGIN` | Vite management origin, normally `http://localhost:5173` |
| `DATABASE_URL` | PostgreSQL connection string for non-Compose API runs |
| `SESSION_SECRET` | Cookie/session signing secret; use a unique local value |
| `PRIVATE_MEDIA_ROOT` | Private originals and pending media |
| `PUBLIC_MEDIA_ROOT` | Approved/publishable derivatives |
| `BACKUP_ROOT` | Timestamped backup marker directory |
| `SMTP_HOST` | Empty outside Compose; Compose overrides it to `mailpit` |
| `SMTP_PORT` | Mailpit SMTP port, normally `1025` |
| `DEFAULT_TIMEZONE` | Default event timezone, `Asia/Kolkata` |

Never use a production password, SMTP password, session secret, or Android
signing key in a committed file.

---

## 6. Start the complete local web/API stack with Docker

From the repository root:

```bash
docker compose -f compose.yml up --build -d
```

The first build may take several minutes because the API and worker images
install npm dependencies and generate Prisma Client.

Check the service state:

```bash
docker compose -f compose.yml ps
```

Expected services:

- `db` — PostgreSQL 16, internal only.
- `api` — TypeScript API on port `4000`.
- `worker` — persistent scheduled-publication worker.
- `mailpit` — local SMTP catcher and inbox.
- `admin-web` — Vite management app on port `5173`.
- `public` — Nginx public site on port `8080`.

The API container applies committed Prisma migrations before starting the
development API. You can apply them again safely:

```bash
docker compose -f compose.yml exec api npm run db:migrate
```

Check health and readiness:

```bash
curl -fsS http://localhost:4000/health
curl -fsS http://localhost:4000/ready
```

Expected responses are JSON objects with `ok: true`.

Open the local services:

| Service | URL |
|---|---|
| Public website | http://localhost:8080 |
| Management app through Vite | http://localhost:5173/manage/ |
| Management app through public Nginx | http://localhost:8080/manage/ |
| API health | http://localhost:4000/health |
| API readiness | http://localhost:4000/ready |
| Mailpit inbox | http://localhost:8025 |
| Calendar | http://localhost:8080/calendar.html |
| Archives | http://localhost:8080/archives.html |

The Vite service uses `VITE_PROXY_TARGET=http://api:4000` inside Compose so
direct host access to `http://localhost:5173/manage/` can reach the API through
the container network. Outside Compose, Vite defaults to
`http://localhost:4000`.

---

## 7. Stop, restart, and reset the local stack

Stop services but retain PostgreSQL and media volumes:

```bash
docker compose -f compose.yml down
```

Start existing containers again:

```bash
docker compose -f compose.yml up -d
```

Rebuild after changing Dockerfiles, Compose configuration, or dependencies:

```bash
docker compose -f compose.yml up --build -d
```

Follow API and worker logs:

```bash
docker compose -f compose.yml logs -f api worker
```

Reset the local PostgreSQL database and media volumes. This is destructive and
must not be used against production:

```bash
docker compose -f compose.yml down -v
docker compose -f compose.yml up --build -d
```

---

## 8. Import existing public content and create an admin

The importer is designed to preserve trusted existing public content and is
idempotent. Run it from the API container:

```bash
docker compose -f compose.yml exec api npm run import:static
```

If seed data is available and intended for local development:

```bash
docker compose -f compose.yml exec api npm run db:seed
```

To create a local demo student and approver, provide the password only to the
command. It is not stored in the repository:

```bash
docker compose -f compose.yml exec \
  -e SEED_DEMO_PASSWORD='local-only-long-password' \
  api npm run db:seed
```

Create the first verified local admin through the bootstrap CLI:

```bash
docker compose -f compose.yml exec \
  -e ADMIN_EMAIL=admin@iiitnr.edu.in \
  -e ADMIN_NAME='NSS Administrator' \
  -e ADMIN_PASSWORD='use-a-long-unique-local-password' \
  api npm run db:admin
```

The admin bootstrap is intended for first setup. Do not put the password in
Git, `.env.example`, screenshots, test fixtures, or the Android application.

---

## 9. Verify registration and Mailpit email delivery

1. Open http://localhost:5173/manage/register or
   http://localhost:8080/manage/register.
2. Register an address ending exactly in `@iiitnr.edu.in`.
3. Open http://localhost:8025.
4. Open the verification message and follow its link.
5. Return to the management app and sign in.

The server accepts the institutional domain case-insensitively but rejects
lookalike suffixes such as `@iiitnr.edu.in.example.org`.

Password recovery is available at:

```text
/manage/forgot-password
/manage/reset-password?token=...
```

Reset and verification tokens are single-use. Mail delivery problems do not
erase database-backed in-app notifications, but Mailpit must be running for
local email inspection.

---

## 10. Build the API and management web application

The root build compiles both TypeScript workspaces and creates the Vite
production bundle:

```bash
npm run build
```

Build only the API:

```bash
npm run build:api
```

Build only the management web app:

```bash
npm run build:web
```

Generated locations:

```text
apps/api/dist/
apps/admin-web/dist/
```

Run the compiled API outside Compose after setting a valid `DATABASE_URL` and
other environment variables:

```bash
npm run start:api
```

Run the compiled worker:

```bash
npm run start:worker
```

For normal development, use Compose instead because it supplies PostgreSQL,
Mailpit, media volumes, and the internal service names.

---

## 11. Run the preserved static website only

If you only need the original public website and do not need the CMS/API,
serve the repository root with a static server:

```bash
python3 -m http.server 8000
```

Open:

```text
http://localhost:8000/
```

Alternatively:

```bash
npx serve .
```

Do not run this static server on port `8080` while Docker Compose is running;
Compose's Nginx public service owns port `8080`.

The static-only mode does not provide authentication, database content,
uploads, moderation, scheduled publishing, Mailpit, or the management app.

---

## 12. Install Flutter and Android tooling

The Flutter client is under `apps/mobile/`. Android builds require a complete
Flutter and Android toolchain; Node.js alone is not sufficient.

The current mobile project declares:

- Flutter `>=3.35.0`.
- Dart `>=3.9.0 <4.0.0`.
- Android `minSdk 24` (required by the current `image_picker_android` release).
- Android application id `edu.iiitnr.nss`.
- Android Gradle Plugin and Kotlin plugin versions are pinned in
  `apps/mobile/android/settings.gradle`; do not replace the generated Android
  project with a new template.

For the Flutter 3.47.x toolchain currently used to verify this repository, the
Android project also uses:

- Gradle `8.14` in `apps/mobile/android/gradle/wrapper/gradle-wrapper.properties`.
- Android Gradle Plugin `8.11.1`.
- Kotlin Gradle Plugin `2.2.20`.
- Android NDK `28.2.13676358`.
- Java 17 bytecode compatibility for Java and Kotlin tasks.

If a newer Flutter SDK reports different minimum versions, follow the version
requirements printed by that SDK rather than blindly copying these numbers.

### Windows recommendation

Install:

1. Flutter stable SDK.
2. Android Studio.
3. Android SDK command-line tools.
4. Android SDK platform tools.
5. At least one Android SDK platform recommended by `flutter doctor`.
6. Android emulator system image, or connect a physical device.
7. A compatible Java installation supplied/recommended by the current Android
   Studio/Flutter toolchain.

Add Flutter's `bin` directory to the Windows `PATH`, restart terminals, and
verify:

```powershell
flutter --version
dart --version
flutter doctor
```

In PowerShell, do not use Bash's trailing `\` for multiline commands. Use a
single line, or PowerShell's backtick character. From the repository root, the
mobile scripts are:

```powershell
npm run mobile:get
npm run mobile:format
npm run mobile:analyze
npm run mobile:test
npm run mobile:apk
```

If Flutter is installed but is not yet on `PATH`, use its full Windows path for
the first verification:

```powershell
& 'C:\Users\<you>\Desktop\flutter\flutter\bin\flutter.bat' --version
```

Accept Android licenses when requested:

```bash
flutter doctor --android-licenses
```

Then run `flutter doctor` again. Resolve every Android toolchain error before
expecting an APK build to work.

If Flutter is installed on Windows but commands are being run from WSL, make
sure the Flutter SDK path is available to the shell. A Windows Flutter SDK and
a Linux WSL Flutter SDK are different installations; use one consistently for
the commands in a given terminal.

---

## 13. Prepare and verify the Flutter application

From the repository root:

```bash
npm run mobile:get
npm run mobile:format
npm run mobile:analyze
npm run mobile:test
```

Equivalent commands from the app directory:

```bash
cd apps/mobile
flutter pub get
dart format lib test
flutter analyze --no-fatal-infos
flutter test
```

The Flutter app uses:

- Riverpod for state and dependency injection.
- Go Router for route guards and deep links.
- Dio for the versioned API and multipart uploads.
- Flutter secure storage for access/refresh credentials.
- Native image picker/camera integration.
- Cached network images.
- Background downloader queue support.

The `--no-fatal-infos` flag keeps informational lint findings visible without
blocking local verification. Syntax and analyzer errors still fail the command.

The app does not contain a production URL or production secret by default.
Always select the API origin with `--dart-define`.

---

## 14. Run Flutter on an Android emulator

Start an Android emulator from Android Studio's Device Manager, or use the
command-line emulator tools. Confirm the device is visible:

```bash
flutter devices
```

With the local Compose API running, the Android emulator reaches the host using
`10.0.2.2`:

```bash
flutter run \
  --target apps/mobile/lib/main.dart \
  --dart-define=NSS_API_BASE_URL=http://10.0.2.2:4000/api/v1
```

The equivalent PowerShell command, run from `apps/mobile`, is:

```powershell
flutter run --target lib/main.dart --dart-define=NSS_API_BASE_URL=http://10.0.2.2:4000/api/v1
```

Do not use `localhost` inside the Android emulator. `localhost` there refers to
the emulator itself, not the Windows/Linux development host.

The debug Android configuration permits the local HTTP development endpoint.
This exception is intended for debug use only. Production must use HTTPS.

---

## 15. Run Flutter on a physical Android device

### Option A: ADB reverse

Enable Developer Options and USB debugging on the device, connect it, and
confirm it appears:

```bash
adb devices
flutter devices
```

Set up a reverse tunnel from the device to the host:

```bash
adb reverse tcp:4000 tcp:4000
```

Run the app with:

```bash
flutter run \
  --target apps/mobile/lib/main.dart \
  --dart-define=NSS_API_BASE_URL=http://127.0.0.1:4000/api/v1
```

From PowerShell, after changing into `apps/mobile`, use:

```powershell
flutter run --target lib/main.dart --dart-define=NSS_API_BASE_URL=http://127.0.0.1:4000/api/v1
```

### Option B: Trusted LAN address

Find the development computer's LAN IP, ensure the host firewall permits only
the intended development port, and run with that address:

```bash
flutter run \
  --target apps/mobile/lib/main.dart \
  --dart-define=NSS_API_BASE_URL=http://192.168.x.x:4000/api/v1
```

PowerShell equivalent from `apps/mobile`:

```powershell
flutter run --target lib/main.dart --dart-define=NSS_API_BASE_URL=http://192.168.x.x:4000/api/v1
```

Do not expose the development API broadly to untrusted networks. Use a trusted
LAN only and close the firewall rule after testing.

---

## 16. Build the Android APK

Build a debug APK for the emulator/local API:

```bash
npm run mobile:apk
```

The root script changes into `apps/mobile` before invoking Flutter. This is
important because the repository root is a Node workspace and does not contain
the Flutter `pubspec.yaml`.

The equivalent direct command is:

```bash
cd apps/mobile
flutter build apk \
  --debug \
  --target-platform android-arm64 \
  --dart-define=NSS_API_BASE_URL=http://10.0.2.2:4000/api/v1
```

Expected output:

```text
apps/mobile/build/app/outputs/flutter-apk/app-debug.apk
```

Install it on a connected device:

```bash
adb install -r apps/mobile/build/app/outputs/flutter-apk/app-debug.apk
```

For a release build, configure a real Android signing key in the Android build
environment. Do not use a debug key for production distribution and do not
commit `*.jks`, `key.properties`, passwords, or signing credentials.

Example release-oriented command after signing is configured:

```bash
flutter build apk \
  --release \
  --target-platform android-arm64 \
  --dart-define=NSS_API_BASE_URL=https://your-real-domain.example/api/v1
```

The repository does not claim a release APK until this command and the device
acceptance tests have actually passed.

---

## 17. Web/API quality checks

Run all available JavaScript checks from the repository root:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm --workspace apps/api run test:integration
npm run test:e2e
```

Additional checks:

```bash
npx prisma validate --schema apps/api/prisma/schema.prisma
bash -n scripts/backup.sh scripts/restore.sh
git diff --check
npm audit --omit=dev --audit-level=high
```

The API integration runner starts an isolated embedded PostgreSQL instance and
checks database migration/import behavior, public SSR routes, ICS output,
mobile login, bearer authorization, refresh-token reuse protection, and other
API behavior.

The Playwright suite uses:

- Desktop Chromium.
- Mobile Chromium.
- Preserved public URLs.
- Management login and recovery pages.
- Participant-management route guards, CSV parsing, editing, and pagination.

WebKit/iPhone Safari is optional in the current Playwright configuration:

```bash
PLAYWRIGHT_WEBKIT=1 npm run test:e2e
```

This is not a replacement for testing on a physical iPhone/iPad.

---

## 18. Test the photo workflow locally

Start Compose and complete the account setup first:

```bash
docker compose -f compose.yml up --build -d
docker compose -f compose.yml exec api npm run import:static
docker compose -f compose.yml exec \
  -e ADMIN_EMAIL=admin@iiitnr.edu.in \
  -e ADMIN_NAME='NSS Administrator' \
  -e ADMIN_PASSWORD='local-only-long-admin-password' \
  api npm run db:admin
```

Then:

1. Register a student account from the management web app.
2. Open Mailpit and verify the account.
3. Sign in as admin and create/publish an event.
4. Confirm the upload window is open.
5. Sign in as the student and upload multiple JPEG, PNG, or WebP files.
6. Inspect **My contributions**.
7. Sign in as an approver and open **Review queue**.
8. Inspect private previews and warning context.
9. Reject one item with a reason.
10. Approve another item while its parent event is published.
11. Confirm the approved derivative appears in the public gallery.
12. Confirm pending/rejected/private originals are not public.

Important upload defaults:

- 15 MiB maximum per file.
- 30 files per batch.
- 40 million pixels maximum.
- JPEG, PNG, and WebP initially.
- Recommended minimum: 800×600.
- Exact duplicates are blocked/flagged by SHA-256.
- Near duplicates and quality issues produce warnings for human review.

---

## 19. Scheduler and worker checks

The worker uses database-backed scheduled jobs. It must be running for future
publication:

```bash
docker compose -f compose.yml logs -f worker
```

To test a scheduled event:

1. Create a draft event in the management app.
2. Schedule it a few minutes in the future.
3. Confirm a `ScheduledJob` appears in the admin schedule page.
4. Restart only the worker:

```bash
docker compose -f compose.yml restart worker
```

5. Wait for the due time and confirm the event publishes once.
6. Archive or unpublish another scheduled event before its due time and
   confirm it does not become public.

The worker must not republish archived, cancelled, deleted, manually
unpublished, or superseded content.

---

## 20. Backup and restore commands

The backup scripts are operator commands and are not automatically run by the
local development stack.

Create a backup from a host with PostgreSQL and media storage available:

```bash
POSTGRES_CONTAINER=nss-db-1 \
POSTGRES_USER=nss \
POSTGRES_DB=nss \
MEDIA_ROOT=/var/lib/nss-media \
./scripts/backup.sh /var/backups/nss
```

The script creates:

- PostgreSQL custom-format dump.
- Compressed media archive.
- SHA-256 checksum file.

Restore only into an isolated clean environment first:

```bash
RESTORE_CONFIRM=YES \
POSTGRES_CONTAINER=nss-db-1 \
POSTGRES_USER=nss \
POSTGRES_DB=nss \
MEDIA_ROOT=/var/lib/nss-media \
./scripts/restore.sh /var/backups/nss/<timestamped-backup>
```

Do not restore over live data without a reviewed maintenance plan and a
separate verified backup. A backup script passing shell syntax validation is
not evidence that a restore drill succeeded.

---

## 21. Production build and Ubuntu deployment outline

Production deployment is manual and must not be performed from this guide
without explicit authorization.

The target is Ubuntu 24.04.1 LTS with:

- Docker Compose for PostgreSQL, API, and worker.
- Existing host Nginx as reverse proxy/static server.
- HTTPS and secure cookies.
- Private originals outside the public Nginx path.
- Public derivatives served only after publication checks.

Before deployment:

```bash
npm run typecheck
npm run lint
npm test
npm --workspace apps/api run test:integration
npm run build
```

Review and configure `/srv/nss-app/.env.production` with real values. Never
copy `.env` development passwords into production.

The committed production topology is:

```bash
docker compose \
  --env-file /srv/nss-app/.env.production \
  -f deploy/compose.production.yml \
  up -d --build
```

Then apply migrations deliberately:

```bash
docker compose \
  --env-file /srv/nss-app/.env.production \
  -f deploy/compose.production.yml \
  exec api npm run db:migrate
```

Back up the existing Nginx configuration before adding the NSS server block,
run `sudo nginx -t`, and reload only after the new configuration validates.
Keep unrelated Nginx sites unchanged.

See `PLATFORM.md` for the full production checklist, TLS notes, firewall
guidance, rollback process, backup policy, and restore procedure.

---

## 22. Common problems

### `docker: command not found` or Docker daemon unavailable

- Start Docker Desktop.
- Enable the current WSL distribution under Docker Desktop WSL Integration.
- Restart the WSL terminal.
- Run `docker info`.

### Port already in use

Check which process owns the port:

```bash
ss -ltnp | grep -E ':4000|:5173|:8080|:8025'
```

Stop the conflicting process or change the local Compose port mapping. Do not
change the internal API port without also changing dependent configuration.

### The management app loads but API requests fail at port 5173

Confirm that the Compose service has:

```text
VITE_PROXY_TARGET=http://api:4000
```

Then recreate the management container:

```bash
docker compose -f compose.yml up -d --force-recreate admin-web
```

### The Android emulator cannot reach the API

Use:

```text
http://10.0.2.2:4000/api/v1
```


Do not use `localhost` from inside the emulator.

### The physical phone cannot reach the API

Use `adb reverse` or a trusted LAN IP. Confirm USB debugging, `adb devices`,
host firewall rules, and that the API is bound to a host-accessible port.

### Mailpit has no message

Check:

```bash
docker compose -f compose.yml ps mailpit api
docker compose -f compose.yml logs --tail=100 api
```

Compose must set `SMTP_HOST=mailpit` and `SMTP_PORT=1025` for the API.

### Prisma migration or client errors

Run:

```bash
npx prisma validate --schema apps/api/prisma/schema.prisma
npx prisma generate --schema apps/api/prisma/schema.prisma
docker compose -f compose.yml exec api npm run db:migrate
```

Do not delete database volumes unless you intentionally want to destroy local
data.

### Flutter or Dart command not found

Install Flutter stable, add Flutter to `PATH`, install Android Studio/SDK,
restart the terminal, and run:

```bash
flutter doctor
```

### Release APK signing fails

Configure the Android signing key in the local build environment. Never fall
back to the debug signing key for a production APK.

### Uploads appear successful but are not public

Approval and publication are separate states. Verify:

- The event is public/published.
- The event upload/gallery release rules permit publication.
- The worker is running.
- The media derivative has been created.
- The public gallery API lists the item.

Pending, rejected, private-event, and scheduled-event originals must remain
private.

---

## 23. Current verification limitations

The web/API/Docker path can be verified locally when Docker Desktop is running.
The native Android path requires the Flutter and Android toolchains and a real
emulator or device. Do not report an APK build, Android test, iPhone Safari
test, or backup/restore drill as passed unless that exact command or workflow
has been run successfully.

For the latest checked results and known gaps, see the verification section at
the end of `PLATFORM.md`.

---

## 24. Official references

Use the current official documentation when installing or upgrading tools:

- Flutter installation: https://docs.flutter.dev/install
- Flutter Android setup: https://docs.flutter.dev/platform-integration/android/setup
- Flutter Android release builds: https://docs.flutter.dev/deployment/android
- Flutter command reference: https://docs.flutter.dev/reference/flutter-cli
- Android Studio: https://developer.android.com/studio
- Android SDK command-line tools: https://developer.android.com/tools
- Docker Desktop WSL2 integration: https://docs.docker.com/desktop/features/wsl/
- Docker Compose: https://docs.docker.com/compose/
- Playwright: https://playwright.dev/docs/intro

# NSS IIIT Naya Raipur Platform — Security Audit Report

**Review date:** 2026-10-15  
**Workspace:** `/mnt/c/Users/samai/Desktop/nss_app`  
**Review type:** Defensive source-code, dependency, and deployment-configuration review  
**Scope:** Current working tree, including the API, management web app, public renderer, Docker/Compose files, Nginx configuration, backup scripts, and Flutter client  
**Status:** Actionable findings identified; do not treat this report as a clean penetration-test certificate

## Executive summary

The repository contains several good security controls: Argon2id password
hashing, hashed email/refresh/session tokens, rotating mobile refresh tokens,
server-side role checks, CSRF protection for browser sessions, strict
institutional-email validation, image signature checks, Sharp pixel limits,
path-bound media access, and escaped public HTML rendering.

The review also found issues that should be addressed before exposing the
application to an untrusted internet audience:

1. Authentication and email workflows have only a broad global rate limit, not
   endpoint-specific protections. This leaves login brute force, password-reset
   mail abuse, and registration mail abuse insufficiently constrained.
2. When SMTP is not configured, verification and password-reset links, including
   their tokens, are written to application logs.
3. The committed development Compose file exposes services and uses predictable
   development credentials. It is safe only for a trusted local network and must
   never be used as an EC2 production stack.
4. The production Nginx snippet uses the entire repository as its document root.
   Without the additional deny rule described in `deployece.md`, repository
   metadata and documentation can be served publicly.
5. Multipart image processing can consume substantial CPU, memory, disk, and
   bandwidth for a verified account. There is no per-user quota or upload
   concurrency limit.
6. The mobile app has an insecure HTTP emulator URL as its compile-time default.
   A release build made without the required `--dart-define` can be pointed at a
   non-TLS endpoint.
7. The full dependency audit is not clean: the development dependency tree
   contains one moderate and two critical advisories in Vitest/Tinypool. The
   production-only dependency audit passed with zero vulnerabilities.

These are configuration/code issues, not evidence that an attacker has already
compromised the system. No external scanning, exploitation, credential testing,
or production attack was performed.

## Severity model

- **Critical:** likely direct compromise or severe impact with a practical path.
- **High:** significant account takeover, data exposure, or availability risk.
- **Medium:** meaningful abuse or defense-in-depth weakness requiring conditions.
- **Low:** limited impact, hardening gap, or low-probability issue.

## Findings summary

| ID | Severity | Finding | Main location |
|---|---|---|---|
| SEC-001 | High | Authentication and email workflows lack dedicated rate limits | `apps/api/src/app.ts:28`, `apps/api/src/routes.ts:105-227` |
| SEC-002 | High | Auth tokens are logged when SMTP is unset | `apps/api/src/mail.ts:9-12` |
| SEC-003 | High (conditional) | Development Compose exposes insecure services and defaults | `compose.yml:5-98` |
| SEC-004 | Medium | Repository checkout can be used as the public Nginx document root | `deploy/nginx/production-snippet.conf:8,42` |
| SEC-005 | Medium | Image upload processing lacks per-user quota/concurrency controls | `apps/api/src/routes.ts:318-355`, `apps/api/src/media.ts:79-110` |
| SEC-006 | Medium | Email verification is a state-changing GET and consumes a token on first request | `apps/api/src/routes.ts:174-181` |
| SEC-007 | Medium | Verification/reset tokens are placed in URL query strings | `apps/api/src/routes.ts:113,125,190,200` |
| SEC-008 | Medium | Release mobile configuration defaults to plain HTTP emulator URL | `apps/mobile/lib/config.dart:1-4` |
| SEC-009 | Medium | Container build is rootful and not fully lockfile/reproducibility hardened | `apps/api/Dockerfile:1-11` |
| SEC-010 | Moderate | Development dependency audit has two critical and one moderate advisory | `package-lock.json`, Vitest/Tinypool tree |
| SEC-011 | Low/Medium | No enforced Content Security Policy | `apps/api/src/app.ts:23` |

---

## SEC-001 — Authentication and email workflows lack dedicated rate limits

**Severity:** High  
**Confidence:** High  
**Affected code:** `apps/api/src/app.ts:28`; authentication routes in
`apps/api/src/routes.ts:105-227`

### Evidence

The API installs one broad in-memory limiter:

```ts
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, ... }));
```

The same limit covers login, mobile login, registration, password reset,
mobile refresh, public reads, uploads, and administration. There is no stricter
limiter keyed by account/email for:

- `/auth/login`
- `/auth/mobile/login`
- `/auth/register`
- `/auth/forgot-password`
- `/auth/mobile/forgot-password`
- `/auth/reset-password`
- `/auth/mobile/reset-password`

### Risk

An attacker can repeatedly try passwords against institutional accounts, send
large numbers of password-reset or verification emails, or create repeated
registration attempts. The broad IP limit is not a substitute for endpoint
limits, account/email throttling, cooldowns, or an abuse response. The default
in-memory store also resets on process restart and is not shared if the service
is later scaled horizontally.

### Recommended correction

Add route-specific limits, for example:

- Login: low burst allowance per IP plus a normalized-email limiter.
- Password reset: very low per-email and per-IP allowance with a generic
  response maintained for account enumeration resistance.
- Registration and verification mail: per-email cooldown and daily quota.
- Refresh: abuse detection and a lower per-session limit.
- Upload: separate user quota and concurrency control.

Use a shared Redis-backed limiter if more than one API instance is deployed.
Keep the existing global limiter as a coarse secondary control. Emit audit or
security events when limits are exceeded, without logging passwords or tokens.

### Verification gap

No automated test currently proves brute-force resistance, password-reset
cooldowns, email-send quotas, or limiter behavior after restart.

---

## SEC-002 — Auth tokens are logged when SMTP is unset

**Severity:** High  
**Confidence:** High  
**Affected code:** `apps/api/src/mail.ts:9-12`

### Evidence

When `SMTP_HOST` is empty, the fallback logger receives the entire message text:

```ts
logger.info({ to, subject, text }, 'mail catcher fallback: message logged because SMTP_HOST is unset');
```

The `text` value contains verification and password-reset URLs created in
`apps/api/src/routes.ts`. Those URLs contain one-time bearer tokens. The Pino
redaction configuration cannot reliably remove a token embedded inside an
arbitrary text string.

### Risk

Anyone with application log access can use an unexpired verification or reset
token to verify an account or change its password. This is especially dangerous
if SMTP is accidentally omitted in production and logs are shipped to a shared
log platform, retained in backups, or readable by support/operations staff.

### Recommended correction

- Fail production startup when `SMTP_HOST` is empty instead of logging message
  bodies.
- In non-production, log only a redacted event such as recipient domain and
  message type; never log the URL, token, or full body.
- Add a structured `mailType` field and redact it at the boundary if needed.
- Test that production configuration rejects an empty SMTP host.
- Rotate any sessions/tokens if a production instance has already logged live
  links.

The deployment guide correctly tells operators to configure SMTP, but the API
should enforce this itself rather than relying on operator discipline.

---

## SEC-003 — Development Compose exposes insecure services and defaults

**Severity:** High if used outside a trusted workstation; otherwise a deployment footgun  
**Confidence:** High  
**Affected code:** `compose.yml:5-98`

### Evidence

The development Compose file publishes services on all host interfaces:

```yaml
api:
  ports:
    - "4000:4000"
mailpit:
  ports:
    - "8025:8025"
admin-web:
  ports:
    - "5173:5173"
public:
  ports:
    - "8080:80"
```

It also supplies predictable fallback values such as:

```yaml
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-nss_dev_password}
SESSION_SECRET: ${SESSION_SECRET:-local-only-change-this-session-secret-123456}
```

### Risk

If an operator runs `docker compose up` on an EC2 instance or another reachable
host, the API, Vite development server, and Mailpit UI become network-accessible.
Mailpit can expose verification/reset messages, and weak defaults reduce the
cost of attacking local sessions or the development database. The Vite server
and bind-mounted checkout are development tools, not hardened production
services.

### Recommended correction

- Make the development file bind to `127.0.0.1` for host-published ports, or
  require an explicit opt-in variable before binding externally.
- Remove insecure fallback secrets from any file that could be used in a
  deployment context; fail if required values are absent.
- Keep using `deploy/compose.production.yml` for EC2.
- Add an automated check that rejects production deployment when Compose
  exposes `4000`, `5173`, `5432`, or `8025` publicly.
- Treat any server that has run the development stack on a public address as
  exposed: rotate database/session credentials and inspect Mailpit/logs.

The production Compose file correctly binds the API to `127.0.0.1:4000` and
does not publish PostgreSQL, Vite, or Mailpit.

---

## SEC-004 — Repository checkout can be served by production Nginx

**Severity:** Medium  
**Confidence:** High  
**Affected code:** `deploy/nginx/production-snippet.conf:8,42`

### Evidence

The production snippet sets:

```nginx
root /srv/nss-app;
```

and ends with:

```nginx
location / { try_files $uri $uri/ =404; }
```

The committed deny rule blocks some directories, but not all repository
metadata. Files such as `README.md`, `PLATFORM.md`, `package.json`,
`package-lock.json`, Compose files, and audit documentation can be exposed if
the snippet is deployed unchanged.

### Risk

This is primarily information disclosure and reconnaissance assistance. It can
reveal framework versions, routes, deployment paths, operational assumptions,
and security control details. A future accidentally committed secret or backup
file could turn this into a credential disclosure issue.

### Recommended correction

Prefer a separate minimal public root containing only approved public assets and
the compiled management bundle. If the repository must remain the root, add an
explicit deny/allowlist before the generic location for at least:

```text
README*, PLATFORM.md, AUDIT.md, deployece.md, compose*, package*.json,
tsconfig*, Dockerfile*, apps, scripts, deploy, prisma, node_modules, .git
```

Deploy `deploy/nginx/production-snippet.conf` only after `nginx -t` and an
external check that the denied paths return `404`.

`deployece.md` documents an additional deny rule, but the repository config
itself should be safe when copied without undocumented edits.

---

## SEC-005 — Image uploads have no per-user quota or concurrency control

**Severity:** Medium  
**Confidence:** High  
**Affected code:** `apps/api/src/routes.ts:25-35,318-355`; `apps/api/src/media.ts:79-110`

### Evidence

The endpoint accepts up to 30 files per request, each up to 15 MiB, and performs
multiple CPU-intensive Sharp operations, hashing, perceptual hashing, and
derivative work. The broad global limiter allows up to 300 requests per IP in a
15-minute window. There is no per-user daily byte quota, concurrent-job cap,
or upload processing queue/backpressure.

### Risk

A verified account or compromised account can consume significant bandwidth,
temporary disk, CPU, memory, and database capacity. Multiple concurrent uploads
can degrade the API for all users or fill the media volume. Pixel limits reduce
decompression-bomb risk but do not prevent sustained resource exhaustion.

### Recommended correction

- Limit concurrent image-processing jobs globally and per user.
- Add per-user daily file/byte quotas and an administrator override.
- Reject a batch when the aggregate declared size exceeds a safe limit.
- Monitor and alert on temporary directory size and media volume usage.
- Rate-limit upload routes separately from read/auth routes.
- Consider moving Sharp processing to a bounded worker queue.
- Return and audit a clear quota-exceeded event.

Keep the existing signature, pixel, page-count, and decode checks.

---

## SEC-006 — Email verification is a state-changing GET

**Severity:** Medium  
**Confidence:** High  
**Affected code:** `apps/api/src/routes.ts:174-181`

### Evidence

`GET /api/v1/auth/verify?token=...` calls `consumeEmailToken`, updates the
user's `emailVerifiedAt`, and consumes the token on the first request. Email
security scanners, browser prefetchers, link-preview systems, or security
products can request URLs automatically before the user clicks them.

### Risk

An automated link fetch can consume the verification token or verify the account
without the user intentionally completing the action. This is primarily an
availability and workflow-integrity issue, but it can also cause confusing
account-state changes.

### Recommended correction

Change the email link to a confirmation page that does not mutate state. The
page should submit the token in a deliberate POST request with an explicit user
action. Keep the one-time atomic token claim in the POST handler. Apply the same
pattern to any other state-changing link endpoint.

The management UI asks the user to click, but it currently navigates to the
state-changing API GET; the mutation still occurs on the GET request.

---

## SEC-007 — Verification and reset tokens are placed in URL query strings

**Severity:** Medium  
**Confidence:** High  
**Affected code:** `apps/api/src/routes.ts:113,125,190,200`; frontend recovery routes

### Evidence

Mail links contain:

```text
/manage/verify-email?token=...
/manage/reset-password?token=...
```

### Risk

Query strings can be stored in browser history, reverse-proxy access logs,
analytics systems, screenshots, copied URLs, and referrer metadata. The tokens
are hashed at rest, which is good, but a plaintext URL is still a bearer
credential during its short validity period.

### Recommended correction

- Prefer a URL fragment for the initial frontend handoff where practical, or a
  one-time POST handoff that removes the token from the address bar immediately.
- Use a strict `Referrer-Policy: no-referrer` for recovery/verification pages.
- Ensure Nginx, load balancers, browser analytics, and support tooling do not
  retain query strings for these routes.
- Replace the URL with a clean route using `history.replaceState` after reading
  the token.
- Never include tokens in logs, error messages, notification bodies, or support
  telemetry.

---

## SEC-008 — Mobile client defaults to a plain HTTP emulator URL

**Severity:** Medium  
**Confidence:** High  
**Affected code:** `apps/mobile/lib/config.dart:1-4`

### Evidence

The compile-time default is:

```dart
defaultValue: 'http://10.0.2.2:4000/api/v1'
```

### Risk

If a release APK is built without the required `NSS_API_BASE_URL` define, it
will target a development HTTP endpoint. Credentials, refresh tokens, and
uploaded content could be sent without TLS or the app may simply fail outside
an emulator.

### Recommended correction

- Make the default empty or invalid and fail closed in release mode.
- Permit the HTTP emulator default only in debug builds.
- Add a release-build test that inspects the configured API origin and rejects
  `http://`, `localhost`, `127.0.0.1`, and `10.0.2.2`.
- Keep production builds explicit:

```text
--dart-define=NSS_API_BASE_URL=https://<production-domain>/api/v1
```

The current deployment guide correctly instructs operators to pass the HTTPS
value; the code default remains unsafe if that step is missed.

---

## SEC-009 — Container build is rootful and not fully reproducibility hardened

**Severity:** Medium  
**Confidence:** High  
**Affected code:** `apps/api/Dockerfile:1-11`

### Evidence

The image uses a moving base tag and installs dependencies with `npm install`:

```dockerfile
FROM node:24-bookworm-slim
RUN npm install
```

No non-root `USER` is configured. The production containers therefore run as
the image's default root user.

### Risk

A future dependency or application compromise has more power inside the
container. A moving base tag and non-lockfile install reduce supply-chain
reproducibility and can introduce unreviewed dependency changes between
deployments.

### Recommended correction

- Pin the Node base image by a reviewed digest or controlled immutable tag.
- Use `npm ci` after copying the lockfile, with a build stage that contains
  only build dependencies and a smaller runtime stage.
- Generate Prisma artifacts during the build and copy only runtime output.
- Create a dedicated non-root runtime user and run API/worker as that user.
- Make mounted media/backups readable and writable by that UID only where
  required.
- Add image scanning and SBOM generation to CI.
- Add a container health check for `/health` and a worker liveness signal.

Do not make the API container privileged or mount the Docker socket.

---

## SEC-010 — Development dependency audit has critical advisories

**Severity:** Medium for CI/developer machines; low direct production impact if dev dependencies are excluded  
**Confidence:** High  
**Affected dependency tree:** `vitest` → `tinypool`, `@vitest/mocker`

### Evidence

The full audit reported:

```text
3 vulnerabilities: 1 moderate, 2 critical
```

The reported packages are:

- `@vitest/mocker`: path traversal/arbitrary file read advisory.
- `tinypool`: prototype-pollution gadget advisories with potential RCE in
  affected worker-option usage.

`npm audit --omit=dev --audit-level=high` reported **0 vulnerabilities**, so
the production dependency set did not show a high/critical advisory in this
check.

### Risk

The vulnerable packages are development/test tooling, not the API runtime
dependency set. Risk is concentrated in CI or developer environments that run
untrusted test inputs, untrusted repository code, or shared test infrastructure.

### Recommended correction

- Upgrade Vitest to a release that contains the fixed transitive packages.
- Review the breaking-change path before using `npm audit fix --force`.
- Re-run the full and production-only audits after the lockfile update.
- Keep CI test jobs isolated and avoid running untrusted test repositories with
  developer credentials or production network access.
- Pin and review lockfile changes.

Do not blindly apply `npm audit fix --force` on the production branch without
running the existing test suite.

---

## SEC-011 — No enforced Content Security Policy

**Severity:** Low/Medium  
**Confidence:** High  
**Affected code:** `apps/api/src/app.ts:23`

### Evidence

Helmet is enabled, but CSP is explicitly disabled:

```ts
helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false })
```

The public renderer has been carefully updated to escape dynamic values, and no
direct stored-XSS path was confirmed during this review. However, there is no
browser policy limiting script, image, connection, frame, or form origins.

### Risk

If a future content-binding, template, dependency, or third-party asset change
introduces an XSS flaw, CSP will not provide a browser-side containment layer.
It also increases the impact of a compromised third-party script or unsafe
inline content.

### Recommended correction

Introduce CSP in report-only mode first, then enforce a policy tailored to the
existing site. A practical rollout should explicitly account for existing
inline scripts and styles, use nonces or hashes where possible, and restrict:

```text
default-src 'self'
script-src 'self' 'nonce-...'
style-src 'self' 'nonce-...'
img-src 'self' data: https:
connect-src 'self'
object-src 'none'
base-uri 'self'
frame-ancestors 'none'
form-action 'self'
```

Do not copy this policy blindly; validate it against the preserved public site
and management bundle.

---

## Controls that are already working well

The following controls were confirmed by source review:

- Passwords use Argon2id (`apps/api/src/auth.ts:163-169`).
- Browser sessions and mobile refresh tokens are stored as hashes, not plaintext.
- Mobile access tokens are short-lived and signed with an HMAC tied to the
  server secret.
- Mobile refresh rotation detects reuse and revokes the refresh-token family.
- Resetting a password revokes existing browser and mobile sessions.
- Browser state-changing requests require a CSRF token and same-origin check.
- Role checks are server-side; UI hiding is not the only authorization layer.
- Self-approval and self-removal-review checks exist.
- Institutional email validation rejects lookalike suffixes.
- Uploads check file signatures, decodeability, dimensions, pages, and pixel
  limits; storage keys are generated rather than derived from the original name.
- Media path helpers prevent ordinary `..` traversal outside media roots.
- Dynamic public text is escaped or written with Cheerio `.text()`.
- Homepage URLs and image URLs use allowlisted schemas/paths.
- Production Compose binds the API only to localhost and does not publish the
  database, worker, Vite, or Mailpit.
- `.env`, `.env.*`, Android keystores, and `key.properties` are ignored by Git.

These controls lower risk but do not eliminate the findings above.

## Checks performed

The following commands were run against the current workspace:

```text
npm audit --omit=dev --audit-level=high       PASS: 0 vulnerabilities
npm audit --audit-level=high                  FINDINGS: 3 dev-tool advisories
npm run typecheck                             PASS
npm run lint                                  PASS
npm test                                      PASS: 12; 2 integration tests skipped
npx prisma validate --schema apps/api/prisma/schema.prisma  PASS
bash -n scripts/backup.sh scripts/restore.sh PASS
git diff --check                              PASS
```

Additional source/configuration checks covered:

- Authentication and authorization middleware.
- Browser CSRF and CORS handling.
- Password reset, verification, session, and mobile token flows.
- Multipart image processing and filesystem path construction.
- Public HTML rendering and CMS binding validation.
- Docker/Compose exposure and production Nginx routes.
- Backup/restore shell scripts.
- Mobile API URL configuration.
- Existing API, content, media, and policy tests.

## Validation limits

This report is not a guarantee that the system is free of vulnerabilities. The
following were not performed:

- External black-box penetration testing.
- Authenticated testing against a deployed production instance.
- AWS account, IAM, security-group, EBS, CloudTrail, Route 53, SES, or S3
  configuration review.
- TLS configuration grading against the live domain.
- DAST, SAST, Semgrep, CodeQL, Trivy, or container-image scanning.
- Restore drill with production-like data.
- Physical-device traffic inspection for the release APK.
- Review of private credentials or production logs.

## Prioritized remediation plan

### Before production exposure

1. Fix SEC-002: never log email bodies or live auth links; fail production when
   SMTP is missing.
2. Fix SEC-001: add endpoint and account/email rate limits with abuse logging.
3. Ensure only `deploy/compose.production.yml` is used on EC2 and add an
   automated deployment guard against the development Compose file.
4. Fix SEC-004: use a minimal public root or deny repository metadata by
   default; verify with external requests.
5. Fix SEC-008: fail release mobile builds that do not use an HTTPS API origin.
6. Add upload quotas/concurrency protection before allowing broad community
   uploads.

### During the next security hardening cycle

1. Convert verification to an explicit POST confirmation flow.
2. Remove tokens from visible URLs and enforce `Referrer-Policy: no-referrer`
   on recovery/verification pages.
3. Harden the Dockerfile with `npm ci`, immutable base images, a non-root user,
   and image scanning.
4. Upgrade the Vitest/Tinypool dependency tree and re-run all audits.
5. Roll out a tested Content Security Policy.
6. Add security regression tests for rate limits, token leakage prevention,
   GET-verification behavior, route authorization, path traversal, and release
   API URL validation.

## Overall conclusion

The application demonstrates a solid baseline for authentication, roles,
token storage, CSRF handling, media validation, and public-content escaping.
It is **not ready to be declared security-cleared for internet production**
until the high-severity findings are addressed and the deployment configuration
is verified on the actual AWS account and domain. The most urgent issues are
token leakage through mail fallback logs, insufficient authentication/email
abuse controls, and preventing accidental use of the insecure development
Compose stack.

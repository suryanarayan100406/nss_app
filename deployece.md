# NSS IIIT Naya Raipur — AWS EC2 deployment and Android APK guide

This is the production runbook for deploying the complete NSS platform to a
single Ubuntu AWS EC2 instance and building the Android APK against that same
public HTTPS deployment.

It covers:

- AWS networking, DNS, SSH, disk, and firewall setup.
- Docker Engine and Docker Compose installation.
- PostgreSQL, API, persistent worker, public website, and management frontend.
- Nginx reverse proxy and HTTPS with Let's Encrypt.
- Production environment variables and SMTP.
- Initial database migration, static-content import, and admin bootstrap.
- Updates, health checks, backups, restore, rollback, and monitoring.
- A debug APK for testing and a signed release APK for distribution.

The guide assumes the repository is already in Git and that you have an
approved production domain. It does **not** perform deployment itself. Replace
every placeholder such as `nss.example.edu.in`, `<AWS_REGION>`, and
`<REPOSITORY_URL>` before running commands.

---

## 1. What the finished deployment looks like

Use one public hostname for the website, management panel, API, and mobile
client:

```text
https://nss.example.edu.in/             public website
https://nss.example.edu.in/manage/      management web app
https://nss.example.edu.in/api/v1/      API
https://nss.example.edu.in/api/v1/health
https://nss.example.edu.in/api/v1/ready
```

The production services are:

| Component | Location | Public exposure |
|---|---|---|
| PostgreSQL 16 | Docker Compose | Internal Compose network only |
| API | Docker Compose | `127.0.0.1:4000` only |
| Worker | Docker Compose | No public port |
| Public website | Host Nginx + repository files/API rendering | Ports 80/443 |
| Management frontend | Built `apps/admin-web/dist` + host Nginx | `/manage/` |
| Mobile client | Android APK | Calls the HTTPS API through Nginx |

Do not expose ports `4000`, `5432`, `5173`, or `8025` to the internet. Mailpit
is for local development and is not part of the production stack.

The production Compose file is:

```text
deploy/compose.production.yml
```

It runs PostgreSQL, API, and worker. The development `compose.yml` is not a
production deployment file.

---

## 2. Before starting: required decisions and credentials

Prepare these values first:

```text
Production domain:        nss.example.edu.in
AWS region:               <AWS_REGION>
EC2 public/Elastic IP:    <ELASTIC_IP>
Git repository URL:       <REPOSITORY_URL>
SMTP hostname:            <SMTP_HOST>
SMTP port:                587
SMTP username:            <SMTP_USER>
SMTP password:            <SMTP_PASSWORD>
SMTP sender:              NSS IIIT Naya Raipur <nss@iiitnr.edu.in>
```

### Production assumptions

- Ubuntu Server 24.04 LTS, x86_64, is recommended for the first deployment.
- A `t3.medium` or larger instance is recommended for PostgreSQL plus image
  processing. Use at least 4 GiB RAM and an encrypted gp3 EBS volume.
- Start with at least 40–80 GiB of EBS storage. Increase it based on original
  image volume and backup retention.
- Use an Elastic IP so DNS does not change after an EC2 stop/start.
- Use an AWS IAM role attached to the instance for S3 backups instead of long-
  lived AWS access keys on the server.
- Use an external SMTP relay. AWS SES is a suitable option after the sender and
  recipient restrictions have been completed.
- Production must use HTTPS. The API intentionally refuses to start when
  `NODE_ENV=production`, `COOKIE_SECURE` is not `true`, or `PUBLIC_ORIGIN` is
  not an HTTPS URL.

### Do not put these in Git

Never commit:

- `.env.production`.
- SMTP passwords.
- Database passwords.
- `SESSION_SECRET`.
- Android keystores, `key.properties`, or signing passwords.
- AWS access keys or private SSH keys.

---

## 3. Create the AWS EC2 instance

### 3.1 Create a key pair

In AWS Console:

1. Open **EC2 → Key pairs**.
2. Create or select an SSH key pair.
3. Download the `.pem` file once and store it securely.
4. Never commit the key to the repository.

On Linux/macOS/WSL, protect the file:

```bash
chmod 600 ~/Downloads/nss-production.pem
```

On Windows PowerShell, keep the file outside the repository and use the OpenSSH
client or Windows Terminal.

### 3.2 Create the security group

Allow only:

| Protocol | Port | Source |
|---|---:|---|
| SSH | 22 | Your fixed office/home IP `/32` |
| HTTP | 80 | `0.0.0.0/0`, `::/0` |
| HTTPS | 443 | `0.0.0.0/0`, `::/0` |

Do not add inbound rules for:

```text
4000, 5432, 5173, 8025, 8080
```

If your IP changes, update the SSH rule rather than opening SSH to the whole
internet. Outbound HTTPS and DNS access are required for package installation,
Docker image pulls, certificate issuance, SMTP, and updates.

### 3.3 Launch the instance

Recommended initial choices:

- Ubuntu Server 24.04 LTS.
- `t3.medium` or larger.
- Encrypted gp3 root EBS volume, at least 40 GiB.
- The security group created above.
- An IAM instance role with the minimum S3 permissions needed for backups, if
  S3 backups are part of the deployment.

Allocate and associate an Elastic IP before continuing.

### 3.4 Connect over SSH

The default Ubuntu user is usually `ubuntu`:

```bash
ssh -i ~/Downloads/nss-production.pem ubuntu@<ELASTIC_IP>
```

Confirm the operating system:

```bash
cat /etc/os-release
uname -m
```

If SSH fails, check the EC2 security group, the instance route, the Elastic IP,
and the key pair before changing application files.

---

## 4. Point DNS to EC2

At your DNS provider, create:

```text
Type: A
Name: nss (or the required host)
Value: <ELASTIC_IP>
TTL: 300
```

If you use IPv6, add an AAAA record only when the instance has a stable IPv6
address and the security rules are configured correctly.

Verify propagation from a terminal:

```bash
dig +short nss.example.edu.in
```

It should return the Elastic IP. Do not request a Let's Encrypt certificate
until the domain resolves to this EC2 instance.

---

## 5. Prepare Ubuntu

Update the system and install host tools:

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  nginx \
  certbot \
  python3-certbot-nginx \
  openssl \
  unzip \
  openjdk-17-jdk
```

Enable the host services:

```bash
sudo systemctl enable --now nginx
sudo systemctl enable --now ssh
```

### 5.1 Configure UFW

Keep the AWS security group as the outer firewall and UFW as a second layer:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <YOUR_FIXED_IP>/32 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Do not enable UFW until the SSH allow rule is correct. Otherwise you can lock
yourself out of the instance.

---

## 6. Install Docker Engine and Compose

Install Docker from Docker's Ubuntu repository, not an unrelated distribution
package:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Reconnect to SSH so the Docker group takes effect:

```bash
exit
ssh -i ~/Downloads/nss-production.pem ubuntu@<ELASTIC_IP>
```

Verify:

```bash
docker version
docker compose version
docker run --rm hello-world
```

If you do not reconnect, use `sudo docker` until the new group membership is
active.

---

## 7. Install Node.js for the management frontend build

The API Docker image contains its own Node runtime. Node is installed on the
host only to build the Vite management frontend.

Install Node 24 to match the API image's major version:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
npm --version
```

The repository requires Node `>=20`. Keep the Node major version consistent
between the host frontend build and the Docker API build.

---

## 8. Check out the application

Create the deployment directories:

```bash
sudo mkdir -p \
  /srv/nss-app \
  /var/lib/nss-postgres \
  /var/lib/nss-media/private-media \
  /var/lib/nss-media/public-media \
  /var/backups/nss

sudo chown -R "$USER":"$USER" /srv/nss-app /var/lib/nss-media /var/backups/nss
```

Clone the approved repository. Use an SSH deploy key or another approved
credential method for a private repository; do not put a personal access token
in the clone URL or shell history.

```bash
git clone <REPOSITORY_URL> /srv/nss-app
cd /srv/nss-app
git checkout <RELEASE_TAG_OR_COMMIT>
```

Confirm the checkout is the intended release:

```bash
git rev-parse --short HEAD
git status --short
```

The deployment path is intentionally fixed to `/srv/nss-app` because the
production Compose file and Nginx configuration use that path.

---

## 9. Create `.env.production`

The API reads the file at:

```text
/srv/nss-app/.env.production
```

The file is used for Compose interpolation and is also passed to the API and
worker containers. Protect it with mode `600`.

Generate hex-only secrets so the PostgreSQL URL does not require URL escaping:

```bash
cd /srv/nss-app
umask 077
DB_PASSWORD="$(openssl rand -hex 32)"
SESSION_SECRET="$(openssl rand -hex 48)"
DOMAIN="nss.example.edu.in"

cat > .env.production <<EOF
NODE_ENV=production
PORT=4000
PUBLIC_ORIGIN=https://${DOMAIN}
MANAGE_ORIGIN=https://${DOMAIN}

POSTGRES_USER=nss
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=nss
DATABASE_URL=postgresql://nss:${DB_PASSWORD}@db:5432/nss?schema=public

SESSION_SECRET=${SESSION_SECRET}
COOKIE_SECURE=true
DEFAULT_TIMEZONE=Asia/Kolkata

PRIVATE_MEDIA_ROOT=/data/private-media
PUBLIC_MEDIA_ROOT=/data/public-media
BACKUP_ROOT=/var/backups/nss

MAX_UPLOAD_BYTES=15728640
MAX_UPLOAD_FILES=30
MAX_IMAGE_PIXELS=40000000
MIN_IMAGE_WIDTH=800
MIN_IMAGE_HEIGHT=600
NEAR_DUPLICATE_HAMMING_DISTANCE=8

# Replace these with an approved production SMTP relay.
SMTP_HOST=<SMTP_HOST>
SMTP_PORT=587
SMTP_USER=<SMTP_USER>
SMTP_PASSWORD=<SMTP_PASSWORD>
SMTP_FROM=NSS IIIT Naya Raipur <nss@iiitnr.edu.in>
MAIL_PREVIEW_BASE_URL=https://${DOMAIN}/api/v1/auth
LOG_LEVEL=info
EOF

chmod 600 .env.production
```

Immediately edit the SMTP placeholders without printing the file:

```bash
nano /srv/nss-app/.env.production
```

Check permissions and confirm no secrets are staged in Git:

```bash
stat -c '%a %n' /srv/nss-app/.env.production
git status --short --ignored /srv/nss-app/.env.production
```

Expected permissions are `600`. Do not run `cat .env.production` in a shared
terminal, CI log, or support ticket.

### SMTP requirements

The API uses Nodemailer. `SMTP_PORT=465` enables TLS directly; `SMTP_PORT=587`
uses the normal submission flow. Configure the relay according to its provider
requirements. Verify:

- The sender address is authorized by the SMTP provider.
- SPF, DKIM, and DMARC are configured for the sender domain.
- Outbound SMTP is permitted by the provider and AWS account.
- Verification and password-reset recipients can receive mail.

Leaving `SMTP_HOST` empty is not a production configuration. The application
falls back to logging email contents and links instead of delivering them.

---

## 10. Build the management frontend

Build the React/Vite frontend on the EC2 host:

```bash
cd /srv/nss-app
npm ci
npm run typecheck:web
npm run lint:web
npm run build:web
test -f apps/admin-web/dist/index.html
```

The important artifact is:

```text
/srv/nss-app/apps/admin-web/dist/index.html
```

The Vite base path is `/manage/`. Do not serve the bundle from `/` or build it
with a different base path. Nginx serves the generated files at `/manage/`.

If you build the frontend in CI or on a workstation instead, copy the complete
`apps/admin-web/dist/` directory to the same path on EC2 before enabling the
management route.

---

## 11. Configure Nginx for HTTP bootstrap

The repository includes the deployment starting point:

```text
deploy/nginx/production-snippet.conf
```

Back up the existing Nginx configuration before adding a site:

```bash
sudo cp -a /etc/nginx /etc/nginx.backup.$(date -u +%Y%m%dT%H%M%SZ)
```

Copy the site and replace the placeholder domain:

```bash
cd /srv/nss-app
sudo cp deploy/nginx/production-snippet.conf /etc/nginx/sites-available/nss-iiitnr
sudo sed -i 's/nss\.example\.edu\.in/nss.example.edu.in/g' /etc/nginx/sites-available/nss-iiitnr
sudo ln -sfn /etc/nginx/sites-available/nss-iiitnr /etc/nginx/sites-enabled/nss-iiitnr
```

Replace the example domain in the command with your actual domain. Inspect the
result:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

The supplied site maps `/api/` and `/media/` to the API, `/manage/` to the
compiled frontend, and the public pages to the API with static fallbacks.

### Protect repository metadata

The supplied Nginx file uses `/srv/nss-app` as its static root. Add an explicit
deny rule before the final generic `location /` block so documentation and
repository metadata are not served accidentally:

```nginx
location ~ ^/(?:README(?:\.md)?|PLATFORM\.md|AUDIT\.md|compose(?:\.yml)?|package(?:-lock)?\.json|tsconfig(?:\.json)?|Dockerfile)(?:/|$) {
  return 404;
}
```

Edit the enabled site with `sudoedit`, then verify again:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Do not expose `/var/lib/nss-media` or `/var/lib/nss-postgres` as Nginx roots.

---

## 12. Enable HTTPS with Let's Encrypt

The API requires HTTPS in production, so obtain the certificate before starting
the production API with `NODE_ENV=production`.

Confirm DNS and port 80 first:

```bash
dig +short nss.example.edu.in
curl -I http://nss.example.edu.in/
```

Request and install the certificate:

```bash
sudo certbot --nginx \
  --redirect \
  --agree-tos \
  --no-eff-email \
  -m admin@nss.example.edu.in \
  -d nss.example.edu.in
```

Use an address monitored by the deployment team for `-m`. Certbot should add a
443 server block and redirect HTTP to HTTPS. Inspect the final configuration:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certificates
curl -I http://nss.example.edu.in/
curl -I https://nss.example.edu.in/
```

The HTTP response should redirect to HTTPS. Verify renewal:

```bash
sudo certbot renew --dry-run
```

The Android build must use this HTTPS origin. Do not build a production APK
against `localhost`, `127.0.0.1`, `10.0.2.2`, or port `4000`.

---

## 13. Start PostgreSQL, migrate, and start the API/worker

Use a deterministic Compose project name so the database container name is
stable for backup scripts:

```bash
cd /srv/nss-app
export COMPOSE_PROJECT_NAME=nss
COMPOSE='docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml'
```

Validate the interpolated production configuration before starting anything:

```bash
$COMPOSE config > /tmp/nss-compose.production.yml
```

Do not paste that generated file into tickets because it contains resolved
configuration values. Remove it after inspection:

```bash
rm -f /tmp/nss-compose.production.yml
```

Build the API/worker image and start only PostgreSQL first:

```bash
$COMPOSE build api worker
$COMPOSE up -d db
```

Wait for PostgreSQL:

```bash
until $COMPOSE exec -T db pg_isready -U nss -d nss; do
  sleep 2
done
```

Run migrations before the API and worker are started:

```bash
$COMPOSE run --rm api npm run db:migrate
```

Start the API and worker:

```bash
$COMPOSE up -d api worker
$COMPOSE ps
```

The API service also runs migrations in its startup command. Running the
migration explicitly first prevents the worker from racing the initial schema
creation; the second migration run is harmless and keeps restart behavior safe.

Check local health:

```bash
curl -fsS http://127.0.0.1:4000/health
curl -fsS http://127.0.0.1:4000/ready
$COMPOSE logs --tail=100 api worker
```

Check the public HTTPS route:

```bash
curl -fsS https://nss.example.edu.in/api/v1/health
curl -fsS https://nss.example.edu.in/api/v1/ready
curl -I https://nss.example.edu.in/manage/
```

The public `/health` path is not the API health route in production. Use
`/api/v1/health` through Nginx or the localhost API port.

---

## 14. Import the preserved website and create the first admin

On a new PostgreSQL database, migrations create the schema but do not populate
the database with the existing static website content. Import the trusted
static content once:

```bash
$COMPOSE exec api npm run import:static
```

Do not run `db:seed` blindly in production. It is intended for local/demo
environments and may create development data.

Create the first administrator without putting the password in the command
history:

```bash
read -r -p 'Admin email: ' ADMIN_EMAIL
read -r -p 'Admin display name: ' ADMIN_NAME
read -r -s -p 'Admin password: ' ADMIN_PASSWORD
printf '\n'

$COMPOSE exec \
  -e ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e ADMIN_NAME="$ADMIN_NAME" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  api npm run db:admin

unset ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD
```

Use a verified institutional address ending in `@iiitnr.edu.in` and a unique,
long password. The one-shot bootstrap variables are not required by the API
after the command finishes.

Open:

```text
https://nss.example.edu.in/manage/login
```

Complete email verification using the production SMTP inbox before testing
authenticated management flows.

---

## 15. Smoke-test the complete deployment

Run these checks after the first deployment:

```bash
curl -fsS https://nss.example.edu.in/api/v1/health
curl -fsS https://nss.example.edu.in/api/v1/ready
curl -fsS https://nss.example.edu.in/ > /tmp/nss-home.html
curl -fsS https://nss.example.edu.in/calendar.html > /tmp/nss-calendar.html
curl -fsS https://nss.example.edu.in/archives.html > /tmp/nss-archives.html
curl -fsS https://nss.example.edu.in/manage/ > /tmp/nss-manage.html
```

Confirm the following manually in a browser:

1. The home page loads over HTTPS.
2. The existing public event pages and `event.html?slug=...` routes work.
3. `/calendar.html` and `/archives.html` load.
4. `/manage/login` displays the sign-in form.
5. Registration sends a verification email.
6. Password reset sends an email.
7. The first admin can sign in.
8. An admin can publish an event and upload/manage media.
9. A mobile browser can load `/manage/` without horizontal overflow.
10. A real Android device can reach the API over cellular/Wi-Fi.

Check the services and disk:

```bash
$COMPOSE ps
df -h
docker system df
sudo journalctl -u nginx --since '30 minutes ago' --no-pager
```

---

## 16. Make the Compose stack start after a reboot

Create a systemd unit that starts the Compose services after Docker:

```bash
sudo tee /etc/systemd/system/nss-app.service > /dev/null <<'EOF'
[Unit]
Description=NSS IIIT Naya Raipur application stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/srv/nss-app
RemainAfterExit=yes
ExecStart=/usr/bin/docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml up -d
ExecStop=/usr/bin/docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml stop
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nss-app
sudo systemctl status nss-app --no-pager
```

After a planned reboot, verify:

```bash
sudo reboot
```

Reconnect and run:

```bash
sudo systemctl status nss-app --no-pager
docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml ps
curl -fsS https://nss.example.edu.in/api/v1/ready
```

---

## 17. Update the deployment safely

Use a tested tag or commit rather than deploying an unreviewed branch:

```bash
cd /srv/nss-app
export COMPOSE_PROJECT_NAME=nss
COMPOSE='docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml'

git fetch --prune --tags
git status --short
git checkout <NEW_RELEASE_TAG_OR_COMMIT>

npm ci
npm run typecheck:web
npm run lint:web
npm run build:web
test -f apps/admin-web/dist/index.html

$COMPOSE build api worker
$COMPOSE run --rm api npm run db:migrate
$COMPOSE up -d api worker

sudo nginx -t
sudo systemctl reload nginx
$COMPOSE ps
curl -fsS https://nss.example.edu.in/api/v1/ready
```

Take a backup before schema or media changes. Review migrations before running
them. A database migration is not automatically reversible, so keep a known
good database backup before production updates.

---

## 18. Backups and off-instance storage

The repository backup script creates a PostgreSQL custom dump, a media archive,
and checksums:

```text
database.dump
media.tar.gz
SHA256SUMS
```

Run it with the actual Compose database container ID. Do not let a host
`DATABASE_URL` override the Docker `pg_dump` path:

```bash
cd /srv/nss-app
DB_CONTAINER="$(docker compose --project-name nss --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml ps -q db)"

env -u DATABASE_URL \
  POSTGRES_CONTAINER="$DB_CONTAINER" \
  POSTGRES_USER=nss \
  POSTGRES_DB=nss \
  MEDIA_ROOT=/var/lib/nss-media \
  ./scripts/backup.sh /var/backups/nss
```

The backup script's default `nss-db-1` is only reliable when the Compose
project name is `nss`; passing the ID explicitly is safer.

### Copy backups to S3

Prefer an EC2 IAM role with only the required S3 permissions. Install the AWS
CLI from the approved AWS distribution, then configure the bucket and prefix.
Do not put AWS access keys in `.env.production`.

Example upload:

```bash
LATEST="$(find /var/backups/nss -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR==1 {print $2}')"
aws s3 cp "$LATEST/" "s3://<BACKUP_BUCKET>/nss/$(basename "$LATEST")/" \
  --recursive \
  --sse aws:kms \
  --sse-kms-key-id <KMS_KEY_ID>
```

Configure an S3 lifecycle policy for retention and an alert when backups are
missing. Also enable encrypted EBS snapshots. Local files on one EC2 volume are
not a disaster-recovery strategy.

### Schedule backups

Create a root cron entry or systemd timer only after manually testing the
command. A simple root cron entry is:

```bash
sudo crontab -e
```

```cron
15 2 * * * cd /srv/nss-app && DB_CONTAINER="$(docker compose --project-name nss --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml ps -q db)" && env -u DATABASE_URL POSTGRES_CONTAINER="$DB_CONTAINER" POSTGRES_USER=nss POSTGRES_DB=nss MEDIA_ROOT=/var/lib/nss-media /srv/nss-app/scripts/backup.sh /var/backups/nss >> /var/log/nss-backup.log 2>&1
```

In production, extend this job to upload the newest backup to S3 and prune
local copies according to the approved retention policy.

---

## 19. Restore procedure

Restore only during a maintenance window. A restore replaces database records
and should restore media from the same backup timestamp.

1. Announce downtime.
2. Take a fresh backup of the current state.
3. Stop API and worker writes.
4. Restore the database and media.
5. Run migrations only if the restored application version requires them.
6. Start services and verify health, public pages, login, and media.

Create a fresh pre-restore backup using the backup command above. Then:

```bash
cd /srv/nss-app
export COMPOSE_PROJECT_NAME=nss
COMPOSE='docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml'
DB_CONTAINER="$($COMPOSE ps -q db)"

$COMPOSE stop api worker
```

The repository restore script overlays files into the media directory. For a
true media replacement, rotate the existing directory first:

```bash
sudo mv /var/lib/nss-media "/var/lib/nss-media.before-restore.$(date -u +%Y%m%dT%H%M%SZ)"
sudo mkdir -p /var/lib/nss-media/private-media /var/lib/nss-media/public-media
sudo chown -R "$USER":"$USER" /var/lib/nss-media
```

Restore the selected timestamp:

```bash
BACKUP=/var/backups/nss/<UTC_TIMESTAMP>

env -u DATABASE_URL \
  RESTORE_CONFIRM=YES \
  POSTGRES_CONTAINER="$DB_CONTAINER" \
  POSTGRES_USER=nss \
  POSTGRES_DB=nss \
  MEDIA_ROOT=/var/lib/nss-media \
  ./scripts/restore.sh "$BACKUP"
```

Start the application again:

```bash
$COMPOSE run --rm api npm run db:migrate
$COMPOSE up -d api worker
$COMPOSE ps
curl -fsS https://nss.example.edu.in/api/v1/ready
```

Keep the rotated media directory until the restore is verified. Delete it only
after the application, database, and media have been checked.

---

## 20. Build the Android APK against EC2

Build the APK after these production checks pass:

- `https://nss.example.edu.in/api/v1/health` works from an external network.
- The TLS certificate is trusted by an Android device.
- `/api/v1/auth/mobile/login` is reachable through Nginx.
- The API and worker are healthy.

The mobile app reads its API URL from the compile-time variable
`NSS_API_BASE_URL`. The production value is:

```text
https://nss.example.edu.in/api/v1
```

It must include `/api/v1` and must not end with a trailing slash.

### 20.1 Build from Windows or another development machine

Building on the development machine is recommended. The EC2 server does not
need the Android SDK just to host the application.

From the repository root in PowerShell:

```powershell
$env:Path = "C:\Users\<you>\Desktop\flutter\flutter\bin;$env:Path"
Set-Location 'C:\Users\<you>\Desktop\nss_app'

npm run mobile:get
npm run mobile:format
npm run mobile:analyze
npm run mobile:test
```

Build a debug APK that points at the live EC2 API:

```powershell
Set-Location 'C:\Users\<you>\Desktop\nss_app\apps\mobile'
flutter build apk `
  --debug `
  --target lib/main.dart `
  --target-platform android-arm64 `
  --dart-define=NSS_API_BASE_URL=https://nss.example.edu.in/api/v1
```

The APK is created at:

```text
apps/mobile/build/app/outputs/flutter-apk/app-debug.apk
```

Install it on a USB-connected device:

```powershell
adb devices
adb install -r 'build\app\outputs\flutter-apk\app-debug.apk'
```

For an emulator using the public EC2 deployment, use the public HTTPS URL too;
do not use `10.0.2.2` because that points to the local emulator host and not to
EC2.

### 20.2 Build an internally signed release APK

For distribution, do not use a debug APK. Generate a release keystore once and
store it in an approved password manager/secure backup:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.android" | Out-Null
keytool -genkeypair -v `
  -keystore "$env:USERPROFILE\.android\nss-release.jks" `
  -alias nss `
  -keyalg RSA `
  -keysize 2048 `
  -validity 10000
```

Create this local-only file at:

```text
apps/mobile/android/key.properties
```

Example format:

```properties
storePassword=REPLACE_WITH_KEYSTORE_PASSWORD
keyPassword=REPLACE_WITH_KEY_PASSWORD
keyAlias=nss
storeFile=C:\\Users\\<you>\\.android\\nss-release.jks
```

Add these patterns to `.gitignore` before building if they are not already
present:

```gitignore
apps/mobile/android/key.properties
*.jks
*.keystore
```

In `apps/mobile/android/app/build.gradle`, add the following before the
`android {` block:

```groovy
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('key.properties')
def hasReleaseKeystore = keystorePropertiesFile.exists()
if (hasReleaseKeystore) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
```

Inside the existing `android { ... }` block, add `signingConfigs` and replace
the empty `buildTypes` block with:

```groovy
signingConfigs {
    release {
        if (hasReleaseKeystore) {
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
            storeFile keystoreProperties['storeFile'] ? file(keystoreProperties['storeFile']) : null
            storePassword keystoreProperties['storePassword']
        }
    }
}

buildTypes {
    release {
        signingConfig hasReleaseKeystore ? signingConfigs.release : signingConfigs.debug
    }
}
```

Immediately after the `android { ... }` block, add this guard so a release
build cannot silently fall back to the debug keystore:

```groovy
if (gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') } && !hasReleaseKeystore) {
    throw new GradleException('Missing apps/mobile/android/key.properties for a release build')
}
```

Run a debug build without `key.properties` if needed. A release build requires
the keystore file and the four values in `key.properties`. Keep the keystore
and `key.properties` outside Git and outside the EC2 application checkout.

Build the signed APK:

```powershell
Set-Location 'C:\Users\<you>\Desktop\nss_app\apps\mobile'
flutter build apk `
  --release `
  --target lib/main.dart `
  --target-platform android-arm64 `
  --dart-define=NSS_API_BASE_URL=https://nss.example.edu.in/api/v1
```

Before distributing, inspect the artifact and install it on a test device. A
production APK can be uploaded to an approved private artifact store or shared
through an authenticated distribution channel. Do not put a private release
APK in the public website root unless that is an intentional product decision.

### 20.3 Optional: build on EC2

Only do this if the server has enough disk and memory. Install the pinned
Flutter SDK, Android command-line tools, Java 17, the Android SDK platform, and
the required NDK on EC2. Then from `/srv/nss-app/apps/mobile` run:

```bash
flutter pub get
dart format lib test
flutter analyze --no-fatal-infos
flutter test
flutter build apk \
  --release \
  --target lib/main.dart \
  --target-platform android-arm64 \
  --dart-define=NSS_API_BASE_URL=https://nss.example.edu.in/api/v1
```

Do not copy the release keystore into a public or shared server without an
approved secret-management process. Local/CI signing is usually safer.

---

## 21. Mobile device smoke test

On a physical Android device connected to the internet:

1. Install the debug or signed release APK.
2. Open the app.
3. Register or sign in with a verified institutional account.
4. Load the event list.
5. Open an event detail page.
6. Select a photograph during the configured upload window.
7. Grant consent and upload.
8. Confirm the upload appears in the management moderation queue.
9. Approve or reject it from the management panel.
10. Confirm the public gallery reflects the moderation decision.

The app should use the public hostname in its request logs. If requests still
target `10.0.2.2`, `localhost`, or `127.0.0.1`, the APK was built without the
production `--dart-define` value.

---

## 22. Monitoring and routine operations

At minimum, monitor:

```text
https://nss.example.edu.in/api/v1/health
https://nss.example.edu.in/api/v1/ready
```

Also check:

```bash
docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml ps
docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml logs --tail=100 api worker
df -h
free -h
sudo systemctl status nginx --no-pager
sudo certbot certificates
```

Set up alerts for:

- `/api/v1/ready` failure.
- API or worker container restarts.
- PostgreSQL health failure.
- Disk usage above 70% and 85% thresholds.
- Backup missing or S3 upload failure.
- TLS certificate expiry.
- SMTP delivery failures.

Configure Docker log rotation so a busy upload/moderation service cannot fill
the root disk. Keep image originals and backups on appropriately sized,
encrypted storage.

---

## 23. Rollback

For an application-only rollback:

```bash
cd /srv/nss-app
git fetch --tags
git checkout <PREVIOUS_KNOWN_GOOD_TAG_OR_COMMIT>
npm ci
npm run build:web

docker compose --project-name nss --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml build api worker
docker compose --project-name nss --env-file /srv/nss-app/.env.production -f deploy/compose.production.yml up -d api worker
sudo nginx -t
sudo systemctl reload nginx
```

Do not assume a code rollback reverses a database migration. For schema
rollback, use the approved backup/restore procedure and a tested compatible
application version.

---

## 24. Common failures

### API container exits with a production configuration error

Check:

```bash
grep -E '^(NODE_ENV|PUBLIC_ORIGIN|MANAGE_ORIGIN|COOKIE_SECURE)=' /srv/nss-app/.env.production
```

The expected values are:

```text
NODE_ENV=production
PUBLIC_ORIGIN=https://nss.example.edu.in
MANAGE_ORIGIN=https://nss.example.edu.in
COOKIE_SECURE=true
```

### Nginx returns 502 for `/api/v1/health`

Check API logs and local health:

```bash
docker compose --project-name nss --env-file /srv/nss-app/.env.production -f /srv/nss-app/deploy/compose.production.yml logs --tail=200 api
curl -v http://127.0.0.1:4000/health
sudo nginx -t
```

### `/manage/` returns 404

The frontend build is missing or is in the wrong location:

```bash
test -f /srv/nss-app/apps/admin-web/dist/index.html
npm run build:web
sudo nginx -t
sudo systemctl reload nginx
```

### Email verification or reset mail does not arrive

Check SMTP values, sender authorization, and API logs. The application logs a
fallback message when `SMTP_HOST` is empty, which is not proof of delivery.

### The APK still calls localhost or `10.0.2.2`

Rebuild with the exact production define:

```powershell
flutter build apk --release --target lib/main.dart --target-platform android-arm64 --dart-define=NSS_API_BASE_URL=https://nss.example.edu.in/api/v1
```

Uninstall the old APK if necessary before testing so an older build is not being
launched.

### Docker build fails on an ARM instance

Check the EC2 architecture and image support:

```bash
uname -m
```

Use an x86_64 `t3` instance for the simplest first deployment, or verify all
Node native dependencies and the `node:24-bookworm-slim` image for the selected
architecture before using Graviton.

### Disk usage grows unexpectedly

Check:

```bash
```

Do not delete PostgreSQL or media directories manually. Follow the retention
and restore policy, and take a backup before cleanup.

---

## 25. Final production checklist

### AWS and host

- [ ] Elastic IP is attached.
- [ ] DNS resolves to the Elastic IP.
- [ ] Security group allows only SSH from trusted IPs, HTTP, and HTTPS.
- [ ] UFW is enabled with an SSH allow rule.
- [ ] Encrypted EBS storage is sized for database, originals, derivatives, and backups.
- [ ] Docker and Nginx start at boot.
- [ ] SSH keys and IAM permissions are protected.

### Application

- [ ] Repository is checked out at an approved release tag/commit.
- [ ] `.env.production` is mode `600` and is not tracked.
- [ ] `PUBLIC_ORIGIN` and `MANAGE_ORIGIN` use the HTTPS domain.
- [ ] `COOKIE_SECURE=true`.
- [ ] SMTP is configured and tested.
- [ ] Management frontend exists at `apps/admin-web/dist/index.html`.
- [ ] PostgreSQL migrations completed.
- [ ] Trusted static content was imported once.
- [ ] First admin was created and email verified.
- [ ] API, worker, and PostgreSQL are healthy.

### Nginx and TLS

- [ ] `sudo nginx -t` passes.
- [ ] HTTP redirects to HTTPS.
- [ ] `/api/v1/health` and `/api/v1/ready` work externally.
- [ ] `/manage/` loads.
- [ ] Repository metadata is not publicly served.
- [ ] `certbot renew --dry-run` passes.

### Backups

- [ ] A manual backup was created.
- [ ] `SHA256SUMS` verifies.
- [ ] The backup was copied to encrypted off-instance storage.
- [ ] Backup scheduling and retention are configured.
- [ ] A restore drill has been performed in an isolated environment.

### APK

- [ ] APK uses `https://<domain>/api/v1`.
- [ ] `flutter pub get`, formatting, analysis, and tests pass.
- [ ] Debug APK was tested on a physical device.
- [ ] Release APK is signed with an approved keystore.
- [ ] Keystore and `key.properties` are not in Git.
- [ ] Login, event loading, uploads, moderation, and refresh behavior work on mobile data.

---

## Official references

- AWS EC2: <https://docs.aws.amazon.com/ec2/>
- AWS security groups: <https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html>
- AWS Elastic IP: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html>
- Docker Engine on Ubuntu: <https://docs.docker.com/engine/install/ubuntu/>
- Docker Compose: <https://docs.docker.com/compose/>
- Nginx: <https://nginx.org/en/docs/>
- Certbot with Nginx: <https://certbot.eff.org/instructions>
- Flutter Android deployment: <https://docs.flutter.dev/deployment/android>
- Flutter Android app signing: <https://docs.flutter.dev/deployment/android#signing-the-app>
- AWS SES: <https://docs.aws.amazon.com/ses/>

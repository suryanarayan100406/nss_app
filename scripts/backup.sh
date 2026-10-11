#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR="${1:-/var/backups/nss}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR/$STAMP"
: "${POSTGRES_CONTAINER:=nss-db-1}"
: "${POSTGRES_USER:=nss}"
: "${POSTGRES_DB:=nss}"
: "${MEDIA_ROOT:=/var/lib/nss-media}"
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump "$DATABASE_URL" --format=custom > "$BACKUP_DIR/$STAMP/database.dump"
else
  docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "$BACKUP_DIR/$STAMP/database.dump"
fi
tar --xattrs --acls -czf "$BACKUP_DIR/$STAMP/media.tar.gz" -C "$MEDIA_ROOT" .
sha256sum "$BACKUP_DIR/$STAMP/database.dump" "$BACKUP_DIR/$STAMP/media.tar.gz" > "$BACKUP_DIR/$STAMP/SHA256SUMS"
echo "Backup created at $BACKUP_DIR/$STAMP"

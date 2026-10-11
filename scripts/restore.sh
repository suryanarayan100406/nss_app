#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 ]]; then echo "Usage: $0 /path/to/backup-directory" >&2; exit 2; fi
BACKUP="$1"
sha256sum -c "$BACKUP/SHA256SUMS"
: "${POSTGRES_CONTAINER:=nss-db-1}"
: "${POSTGRES_USER:=nss}"
: "${POSTGRES_DB:=nss}"
: "${MEDIA_ROOT:=/var/lib/nss-media}"
echo "This replaces the selected database and media volume. Confirm with RESTORE_CONFIRM=YES."
[[ "${RESTORE_CONFIRM:-}" == YES ]] || { echo "Aborted: set RESTORE_CONFIRM=YES" >&2; exit 1; }
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_restore "$DATABASE_URL" --clean --if-exists < "$BACKUP/database.dump"
else
  docker exec -i "$POSTGRES_CONTAINER" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < "$BACKUP/database.dump"
fi
mkdir -p "$MEDIA_ROOT"
tar --xattrs --acls -xzf "$BACKUP/media.tar.gz" -C "$MEDIA_ROOT"
echo "Restore complete. Run migrations and restart the API/worker."

# NSS Android application

This is a native Flutter Android client. It uses the same versioned Express
API and PostgreSQL-backed roles as the web application; it does not embed the
React site or create a second database.

## Toolchain

Install the current Flutter stable SDK and Android Studio/SDK, then run:

```bash
flutter doctor
flutter pub get
dart format lib test
flutter analyze --no-fatal-infos
flutter test
flutter run --target lib/main.dart --dart-define=NSS_API_BASE_URL=http://10.0.2.2:4000/api/v1
flutter build apk --debug --dart-define=NSS_API_BASE_URL=https://nss.example.edu.in/api/v1
```

These commands are run from `apps/mobile`. The Windows Flutter 3.47.x toolchain
has been verified for dependency resolution, formatting, widget tests, and a
debug APK build. `flutter analyze` has no parse errors but currently reports
informational lint findings. A physical-device runtime smoke test is still
pending.

The emulator reaches a development host through `10.0.2.2`. For a physical
device use the host's trusted LAN address, or run `adb reverse tcp:4000 tcp:4000`
and use `http://127.0.0.1:4000/api/v1`. The
debug HTTP URL is intentionally supplied with `--dart-define` and is not a
secret compiled into the app.

The picker handles Android lost-picker data at startup. Each selected image is
an independent `background_downloader` multipart task with a stable client
submission id, consent fields, progress, retry state, and persistent native
queue metadata. The server's per-file response is surfaced as submitted,
duplicate, or failed. Tasks carry the current short-lived bearer token; if a
task outlives that token, sign in again and retry it. Refresh rotation remains
server-authoritative. OS force-stop limits background work, so the queue reports
that a retry is needed rather than claiming an upload completed.

## Routes

Authentication: `/login`, `/register`.

Student shell: `/home`, `/events`, `/events/:slug`, `/uploads`,
`/contributions`, `/inbox`, `/profile`.

Approver: `/review` and `/review/:id`.

Admin: `/admin`, `/admin/events`, `/admin/events/new`,
`/admin/events/:id/edit`, `/admin/archives`, `/admin/archives/:id`, `/admin/media`,
`/admin/users`, `/admin/homepage`, `/admin/audit`. Admins can reach the
management destination from Profile; approvers can reach Review from Profile
or the floating action.

## Mobile implementation audit notes

Implemented in the client:

- API relative media paths are resolved against `NSS_API_BASE_URL`, including
  the authenticated private moderation preview.
- Upload selection honors event opening and closing times, requires consent,
  preserves Android lost-picker recovery, and queues one server request per
  image (up to the API's 30-file batch limit).
- Approvers see the private preview, uploader, dimensions, duplicate warning,
  quality warnings, and the required rejection-reason guard. Admins have the
  documented homepage-revisions route and a reachable management entry point.
- Admins can create and edit core event metadata, dates, upload windows, status,
  visibility, links, tags, and academic-year association; archive detail now
  supports publish/unpublish and team-roster assignment/removal.
- Concurrent expired-access-token requests share one refresh rotation, and
  login failures are rendered as actionable form errors.

The mobile app still depends on the web/API verification and reset links, does
not provide an offline event/contribution cache, and does not yet offer the
full admin parity for cover-media selection, participant import/editing,
scheduling controls, homepage editing, metrics, team editing, or backup
operations available in the management web app. Existing event social URLs, SEO
metadata, and academic-year associations are preserved on edit when the API does
not expose their current values, but cannot be cleared from this form.

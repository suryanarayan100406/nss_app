# NSS platform design system

The management web app and Flutter app share the same visual vocabulary while
respecting each platform's interaction conventions. The public site keeps its
existing editorial motion and layout; the app surfaces use the same warm NSS
palette without copying the public loader or scroll effects.

## Tokens

| Role | Web token | Flutter value | Use |
| --- | --- | --- | --- |
| Canvas | `--paper` | `#F5F1E4` | Main page background |
| Surface | `--paper-2` | `#FBF8F0` | Panels, sheets, form groups |
| Elevated surface | `--bone` | `#FFFDF7` | Dialogs and raised cards |
| Primary text | `--ink` | `#132019` | Headings and primary controls |
| Muted text | `--ink-on-paper-dim` | `#5F6A60` | Supporting copy |
| Primary action | `--moss` | `#496B48` | Submit, publish, navigation selection |
| Warm accent | `--marigold` | `#D79A33` | Focus, highlights, event markers |
| Secondary accent | `--rust` | `#A95036` | Warnings, destructive intent |
| Success | `--success` | `#347A58` | Completed and published states |
| Warning | `--warning` | `#A96D1B` | Quality signals and pending states |
| Error | `--danger` | `#A23B35` | Failed actions and validation |

Web and Flutter should keep normal text at WCAG AA contrast. Focus rings use
the marigold token with at least a 2px visible outline. Buttons, list rows and
icon controls have a minimum 44px web hit area and 48dp Android hit area.

## Type and spacing

- Display: Fraunces where the supplied font is available; Flutter uses a
  locally declared serif fallback with a similar humanist profile.
- Body: Work Sans on web; Flutter's system sans with the same weight hierarchy.
- Scale: 12/14/16/18/22/28/36/48px (or dp on Android).
- Spacing: 4, 8, 12, 16, 24, 32, 48, 64.
- Radii: 8px controls, 14px cards, 22px feature surfaces. Avoid fully round
  containers except status dots and avatars.
- Content width: 1180px maximum on desktop; readable prose stays near 68ch.

## Components

- **Buttons:** one filled primary action per task, quiet outlined secondary
  actions, and text actions for reversible row operations. Destructive actions
  require confirmation when they change publication or access.
- **Inputs:** labels stay visible, help text sits below the control, and
  errors appear adjacent to the field. Preserve values after a failed submit.
- **Status pills:** use text plus color; never communicate state by color alone.
- **Tables:** switch to stacked records below 720px. Keep the row's title and
  primary action visible before secondary metadata.
- **Photo tiles:** reserve the image aspect ratio, expose alt text, and use a
  neutral skeleton while thumbnails load. Never load private originals into a
  list view.
- **Dialogs:** title, consequence, explicit cancel, and a focused confirm
  action. Long moderation previews use a full-screen route on small screens.

## Motion and accessibility

The app uses 120–220ms fades/slides for state changes and no decorative intro
loader. Respect `prefers-reduced-motion` on web and `MediaQuery.disableAnimations`
on Flutter. Keyboard focus, semantic labels, readable empty/error/offline
states, text scaling and safe-area insets are required for every workflow.

## Navigation

Desktop web uses the existing NSS Studio rail grouped as Overview, Content,
Community and System. At phone widths it becomes a drawer plus a compact
bottom action bar. Flutter uses Home, Events, Uploads, Inbox and Profile as the
student destinations; Approver adds Review, and Admin exposes a structured
Management destination without removing the student workflow.

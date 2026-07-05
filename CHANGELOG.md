# Change Log

## [3.2.0] 2026-07-05

### New features
- Add a no-login "whitelist" mode that discovers videos from public RSS feeds
  without a Google login. Requires raw channel IDs; omits video duration and
  livestream filtering.
- Add an interactive `npm run setup` wizard to choose youtube or whitelist mode,
  and `npm run login` for re-authentication.
- Send an alert email when a backend run fails (authentication, quota, or other
  error), once per issue until it recovers. Gated by logging.emailOnError.

### Changes
- Normal startup no longer launches interactive browser auth; use
  `npm run setup` / `npm run login`. A bad token alerts by email and exits.

## [3.1.0] 2026-07-05

### Breaking changes
- Split `config.json` into three files: `config.json` (general settings),
  `secrets.json` (email credentials, or use BBYEN_EMAIL_USER / BBYEN_EMAIL_PASS
  environment variables), and `channels.json` (channel lists). See the
  `.example.json` templates and README.

### New features
- Per-channel muting: set `{ "id": "...", "notify": false }` in
  `channels.json` to track a channel without receiving emails.
- First-scan backlog control: `notifyOnFirstScan` (global, default true) and a
  per-channel override suppress the initial flood of emails when a channel is
  newly added while still recording its videos.
- Open videos in the YouTube app on mobile by using the canonical watch URL
  instead of an attribution link.

## [3.0.2] 2025-01-03

### Fixes
- Fix writing headers after sending response in authentication server.
- Gracefully handle channel page giving 404 (instead of killing the process) (#22).

## [3.0.1] 2024-12-31

### Fixes
- Fix regression that the process would exit when the email quota is up (#23)

## [3.0.0] 2024-11-18

### Breaking changes
- Increase the minimum supported node version from 14 to 16
  This is the reason for the major release. However, the previous version was not
  really compatible with node 14. It was a mistake to list compatibility.

### New features
- Do not use YouTube API to get whitelisted subscriptions (#19)
- Do not permanently delete subscriptions. This shows you the channel name in
  the database if the channel is deleted.

### Maintenance
- Add simple tests (currently only config) that run for all supported node versions

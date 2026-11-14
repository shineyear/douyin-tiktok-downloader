# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/); dates are commit dates. Entries
before 1.5.0 were reconstructed from the git history and the original release
notes when this file was introduced.

## [1.5.0] - 2026-11-14

### Fixed
- **Douyin works again.** Parsing had failed with `Argus 403` since
  mid-September. The API is now reached through the lane Douyin's own
  embeddable player uses: the request carries `Origin: https://open.douyin.com`
  and nothing else — no cookies, no signature, no retry loop.

### Changed
- Removed the cookie-minting path (`ttwid` / `UIFID_TEMP` from a HEAD request)
  and its retries; neither is needed on the embed lane.
- A refused Douyin request now reports the raw HTTP status it got.

### Added
- `VERSION`, this changelog, and the running version in the page footer and in
  the MCP server info.
- README: "How the zero-bandwidth trick works" brought up to date for Douyin
  and Instagram.

## [1.4.6] - 2026-09-17

### Fixed
- Douyin cookie mint in production: `Set-Cookie` is parsed with a fallback for
  runtimes without `Headers.getSetCookie()`, and a failed mint reports what
  the function observed.

## [1.4.5] - 2026-09-07

### Fixed
- Douyin: worked around the new Argus `Uifid Not Found` gate by sending the
  `UIFID_TEMP` value under both cookie names. Partial — roughly half of
  requests passed, hence a bounded, spaced retry.

### Changed
- Douyin errors name the failing stage (cookie mint, Argus 403, empty body).

Known issue: stopped working on 2026-09-18 when Douyin tightened the gate.
Fixed in 1.5.0.

## [1.4.4] - 2026-08-21

### Fixed
- Douyin: skip CDN mirrors that require a `Referer` (`*.douyinvod.com`) — a
  browser cannot send one — and confirm the chosen mirror with a 1-byte range
  request.

## [1.4.3] - 2026-08-17

### Changed
- Douyin parser rebuilt on the web API after Douyin stopped server-rendering
  video data into share pages.
- Unavailable Douyin videos show Douyin's own reason (deleted, private).
- Health check: an unwatchable seed video is reported as a rotted fixture, not
  a parser failure.

## [1.4.2] - 2026-08-02

### Fixed
- TikTok: friends-only, age-gated and region-locked videos get a specific
  message.
- Health check: retries transient CDN 503s; dropped a seed that pointed at a
  friends-only video.

## [1.4.1] - 2026-07-04

### Fixed
- Instagram: switched from the retired graphql `doc_id` to reading the
  logged-out reel page.

## [1.4.0] - 2026-05-12

### Added
- Douyin image posts (图文 / 图集): returned as a list of images, in the web UI
  and through MCP.

## [1.3.0] - 2026-04-26

### Added
- MCP server endpoint (`/mcp`) exposing a `download_video` tool.
- Daily health-check script (`scripts/health-check.sh`).
- LandFirst.ai footer credit.

## [1.2.0] - 2026-04-23

### Changed
- UI cleanup: dropped the backup "Save to Files" button, tightened copy.

## [1.1.1] - 2026-04-23

### Fixed
- Show the video's first frame as preview when the poster image is blocked by
  CORP.

## [1.1.0] - 2026-04-23

### Added
- Two-layer JSON cache (in-process map + Netlify edge).

## [1.0.0] - 2026-04-23

### Added
- Instagram support — four platforms.

## [0.3.0] - 2026-04-23

### Added
- X (Twitter) support.

## [0.2.0] - 2026-04-23

### Added
- TikTok support.

## [0.1.0] - 2026-04-22

### Added
- Initial release: Douyin, zero-bandwidth architecture.

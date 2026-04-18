# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.2.0] - 2026-04-18

### Added
- Release history page at `/changelog` with currently-running version metadata
- Environment badges using canonical display labels (DEV, PRE PROD, PROD)
- Severity-aware version status cluster showing overall dependency health
- Version surface links to release history and GitHub Release
- Build metadata injection from git SHA and timestamp in Docker build

### Changed
- Version display now shows pre-release identifiers in non-production (e.g. `0.2.0-rc+sha.abc1234`)
- `/api/version` response now includes `displayVersion`, `releaseUrl`, and `releaseHistoryUrl`
- `/api/health` response now includes `environmentLabel` and `displayVersion`
- Dashboard layout updated with runtime status cluster per UX-UI standards

## [0.1.0] - 2026-04-18

### Added
- Initial health dashboard with Supabase, SignalR, and Keystone connectivity checks
- `/health` liveness endpoint
- `/api/health` readiness endpoint with service dependency checks
- `/api/version` endpoint with build metadata
- Keystone SSO login flow (handoff JWT pattern)
- Dashboard UI showing real-time connection status
- Dockerfile with HEALTHCHECK directive
- CI/CD workflow from Alterspective standard template

# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

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

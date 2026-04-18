# AGENTS.md — poc-app-deploy-validation

Global rules from `C:\GitHub\AGENTS.md` apply here.

## What This Is

POC application to validate the Alterspective Coolify deployment pipeline (AIRUN-021).
Exercises Supabase, Azure SignalR, and Keystone integrations.

## How to Build and Run

```bash
npm install
npm run dev          # Local development with hot reload
npm run build        # TypeScript compilation
npm start            # Production start
```

## Deployment

This project follows the AIRUN-021 Coolify Deployment Playbook:
- Push to `develop` -> auto-deploys to staging
- PR from `develop` to `main` -> auto-deploys to production + creates GitHub Release

CI/CD workflow: `.github/workflows/ci-cd.yml` (from standard template)

## Version Bumping

Manual bump before production PR. CI verifies and creates GitHub Release.
See `Principles/Web/standards/templates/ci-cd.yml` in Alterspective-Intelligence.

## Environment Variables

See `.env.example` for required variables.

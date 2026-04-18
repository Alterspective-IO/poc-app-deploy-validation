# Deploy Validation POC

Proof-of-concept to validate the [AIRUN-021 Coolify Deployment Playbook](https://github.com/Alterspective-IO/Alterspective-Intelligence/blob/main/Practice/AI/runbooks/AIRUN-021-Coolify-Deployment-Playbook.md) and [APP-VERSIONING-STANDARDS](https://github.com/Alterspective-IO/Alterspective-Intelligence/blob/main/Principles/Web/standards/APP-VERSIONING-STANDARDS.md).

## What This Proves

- Autonomous deployment via Coolify (staging + production from branch pushes)
- Automated GitHub Release creation via `ci-cd.yml` template
- Supabase, Azure SignalR, and Keystone connectivity in a deployed container
- Full APP-VERSIONING-STANDARDS v2.2 compliance

## Quick Start

```bash
npm install
npm run dev      # Local dev with hot reload (tsx watch)
npm run build    # TypeScript compilation
npm start        # Production start
```

## Endpoints

| Path | Purpose |
|------|---------|
| `/` | Dashboard UI with service health status |
| `/health` | Liveness probe |
| `/api/health` | Readiness probe (checks Supabase, SignalR, Keystone) |
| `/api/version` | Build metadata and release URLs |
| `/changelog` | Release history rendered from CHANGELOG.md |
| `/auth/login` | Keystone SSO login redirect |
| `/auth/callback` | Keystone handoff token verification |

## Environments

| Environment | URL | Branch |
|-------------|-----|--------|
| Staging | https://staging.deploy-poc.alterspective.com.au | `develop` |
| Production | https://deploy-poc.alterspective.com.au | `main` |

## Version Bumping

Manual bump before production PR. CI verifies and creates GitHub Release.

```bash
npm version patch --no-git-tag-version  # or: minor, major
# Edit CHANGELOG.md with the new version entry
git add package.json CHANGELOG.md
git commit -m "chore: bump version to X.Y.Z"
```

## Standards Compliance

This app serves as a reference implementation for:
- `APP-VERSIONING-STANDARDS.md` — version surfaces, changelog, GitHub Releases
- `KEYSTONE-DOWNSTREAM-INTEGRATION-STANDARDS.md` — handoff JWT verification, nonce validation
- `SECURITY-STANDARDS.md` — security headers, no leaked internals, fail-closed auth
- `LOGGING-STANDARDS.md` — structured JSON logging
- `ERROR-HANDLING-STANDARDS.md` — global error handler, safe error responses
- `ENVIRONMENT-STANDARDS.md` — env var validation at startup
- `SUPABASE-STANDARDS.md` — singleton client instance
- `DEVOPS-STANDARDS.md` — Coolify deployment, ci-cd.yml template

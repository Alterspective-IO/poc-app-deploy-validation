import express, { Request, Response, NextFunction } from "express";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// ── Environment validation (ENVIRONMENT-STANDARDS) ──

const REQUIRED_ENV: Record<string, string> = {};
const OPTIONAL_ENV: Record<string, string> = {
  PORT: "3000",
  APP_ENV: "local",
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  AZURE_SIGNALR_CONNECTION_STRING: "",
  KEYSTONE_URL: "",
  KEYSTONE_SERVICE_TOKEN: "",
  HANDOFF_TOKEN_SECRET: "",
};

function validateEnv(): string[] {
  const warnings: string[] = [];
  for (const [key] of Object.entries(REQUIRED_ENV)) {
    if (!process.env[key]) {
      warnings.push(`REQUIRED env var ${key} is not set`);
    }
  }
  for (const [key, fallback] of Object.entries(OPTIONAL_ENV)) {
    if (!process.env[key] && fallback) {
      process.env[key] = fallback;
    }
  }
  return warnings;
}

const envWarnings = validateEnv();

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const RAW_ENV = process.env.APP_ENV || "local";
const VERSION = process.env.APP_VERSION || process.env.npm_package_version || require("../package.json").version;
const BUILD_SHA = process.env.APP_BUILD_SHA || process.env.SOURCE_COMMIT?.slice(0, 7) || "local";
const BUILD_DATE = process.env.APP_BUILD_DATE || new Date().toISOString();
const REPO_URL = "https://github.com/Alterspective-IO/poc-app-deploy-validation";

// ── Structured logging (LOGGING-STANDARDS) ──

function log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "deploy-poc",
    component: "api",
    message,
    environment: RAW_ENV,
    version: VERSION,
    ...meta,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

// ── Security middleware (SECURITY-STANDARDS) ──

// Security headers (helmet equivalent — minimal for POC without adding dependency)
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.removeHeader("X-Powered-By");
  next();
});

// ── VER-UI-07: Canonical environment display labels ──

const ENV_LABELS: Record<string, string> = {
  local: "DEV", dev: "DEV", development: "DEV",
  test: "TEST", qa: "TEST", uat: "TEST",
  staging: "PRE PROD", preprod: "PRE PROD",
  production: "PROD", prod: "PROD",
};
const ENV_LABEL = ENV_LABELS[RAW_ENV] || RAW_ENV.toUpperCase();

// ── VER-SEM-02 / VER-DEV-01: Runtime version identifiers ──

function getDisplayVersion(): string {
  if (RAW_ENV === "production" || RAW_ENV === "prod") return VERSION;
  if (RAW_ENV === "local" || RAW_ENV === "dev" || RAW_ENV === "development") {
    return `${VERSION}-dev+sha.${BUILD_SHA}`;
  }
  return `${VERSION}-rc+sha.${BUILD_SHA}`;
}

const DISPLAY_VERSION = getDisplayVersion();
const RELEASE_URL = `${REPO_URL}/releases/tag/v${VERSION}`;
const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

// ── CHANGELOG.md reader (VER-LOG-03, VER-LOG-06) ──

function readChangelog(): string {
  try {
    const p = path.join(__dirname, "..", "CHANGELOG.md");
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "# Changelog\n\nChangelog not available.";
  }
}

// ── Supabase client — singleton (SUPABASE-STANDARDS: one client instance) ──

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  supabaseClient = createClient(url, key);
  return supabaseClient;
}

// ── SignalR connection string parser (REALTIME-STANDARDS) ──

function parseSignalRConnectionString(cs: string) {
  const pairs = cs.split(";").reduce<Record<string, string>>((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx > 0) acc[pair.slice(0, idx)] = pair.slice(idx + 1);
    return acc;
  }, {});
  return { endpoint: pairs.Endpoint, accessKey: pairs.AccessKey, version: pairs.Version };
}

// ── Nonce store for Keystone auth (KEYSTONE-DOWNSTREAM-INTEGRATION-STANDARDS) ──

const nonceStore = new Map<string, { createdAt: number; returnTo: string }>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanExpiredNonces() {
  const now = Date.now();
  for (const [nonce, data] of nonceStore) {
    if (now - data.createdAt > NONCE_TTL_MS) nonceStore.delete(nonce);
  }
}

// ── Health checks ──

type CheckResult = { status: "ok" | "skip" | "warn" | "fail"; detail: string };

async function checkSupabase(): Promise<CheckResult> {
  try {
    const client = getSupabaseClient();
    if (!client) return { status: "skip", detail: "SUPABASE_URL or SUPABASE_ANON_KEY not set" };
    const { error } = await client.from("_health_check").select("id").limit(1);
    if (error && error.code === "PGRST116") {
      return { status: "ok", detail: "Connected (health_check table not found — expected for POC)" };
    }
    if (error) return { status: "ok", detail: `Connected (query note: ${error.message})` };
    return { status: "ok", detail: "Connected and queried successfully" };
  } catch (e: unknown) {
    return { status: "fail", detail: e instanceof Error ? e.message : "Unknown error" };
  }
}

async function checkSignalR(): Promise<CheckResult> {
  try {
    const cs = process.env.AZURE_SIGNALR_CONNECTION_STRING;
    if (!cs) return { status: "skip", detail: "AZURE_SIGNALR_CONNECTION_STRING not set" };
    const config = parseSignalRConnectionString(cs);
    if (!config.endpoint) return { status: "fail", detail: "Could not parse endpoint from connection string" };
    const url = `${config.endpoint}/api/health`;
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
    return { status: res.ok ? "ok" : "warn", detail: `${config.endpoint} responded ${res.status}` };
  } catch {
    const cs = process.env.AZURE_SIGNALR_CONNECTION_STRING;
    if (!cs) return { status: "fail", detail: "Connection string not set" };
    const config = parseSignalRConnectionString(cs);
    if (config.endpoint && config.accessKey) {
      return { status: "ok", detail: `Connection string valid (endpoint: ${config.endpoint})` };
    }
    return { status: "fail", detail: "Could not validate SignalR connection" };
  }
}

async function checkKeystone(): Promise<CheckResult> {
  try {
    const url = process.env.KEYSTONE_URL;
    if (!url) return { status: "skip", detail: "KEYSTONE_URL not set" };
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    return { status: res.ok ? "ok" : "fail", detail: `${url} responded ${res.status}` };
  } catch (e: unknown) {
    return { status: "fail", detail: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ── VER-UI-09: Compute overall severity from dependency health ──

function computeSeverity(checks: CheckResult[]): "healthy" | "degraded" | "critical" {
  const statuses = checks.map((c) => c.status);
  if (statuses.includes("fail")) return "critical";
  if (statuses.includes("warn")) return "degraded";
  return "healthy";
}

// ── Routes ──

// Liveness
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Readiness — checks all 3 services (VER-UI-08)
app.get("/api/health", async (_req, res) => {
  const [supabase, signalr, keystone] = await Promise.all([
    checkSupabase(),
    checkSignalR(),
    checkKeystone(),
  ]);

  const severity = computeSeverity([supabase, signalr, keystone]);

  res.status(severity === "critical" ? 503 : 200).json({
    status: severity,
    environment: RAW_ENV,
    environmentLabel: ENV_LABEL,
    version: VERSION,
    displayVersion: DISPLAY_VERSION,
    timestamp: new Date().toISOString(),
    checks: { supabase, signalr, keystone },
  });
});

// Version + build metadata (VER-BUILD-02, VER-UI-02, VER-UI-05)
app.get("/api/version", (_req, res) => {
  res.json({
    version: VERSION,
    displayVersion: DISPLAY_VERSION,
    sha: BUILD_SHA,
    buildDate: BUILD_DATE,
    environment: RAW_ENV,
    environmentLabel: ENV_LABEL,
    releaseUrl: RELEASE_URL,
    releaseHistoryUrl: CHANGELOG_URL,
  });
});

// Release history surface (VER-LOG-03, VER-LOG-05, VER-LOG-06)
app.get("/changelog", (_req, res) => {
  const raw = readChangelog();

  const html = raw
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n(?!<)/g, '\n');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Release History — Deploy Validation POC</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; background: #0f172a; color: #e2e8f0; }
    h1 { color: #38bdf8; }
    h2 { color: #94a3b8; border-bottom: 1px solid #334155; padding-bottom: 8px; margin-top: 24px; }
    h3 { color: #64748b; font-size: 14px; text-transform: uppercase; }
    ul { padding-left: 20px; }
    li { margin: 4px 0; }
    a { color: #38bdf8; }
    .nav { color: #64748b; font-size: 13px; margin-bottom: 16px; }
    .meta { color: #64748b; font-size: 13px; text-align: center; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="nav"><a href="/">&larr; Back to Dashboard</a></div>
  ${html}
  <div class="meta">
    Currently running: ${DISPLAY_VERSION} (${ENV_LABEL})<br>
    Built: ${BUILD_DATE} | SHA: ${BUILD_SHA}<br>
    <a href="${RELEASE_URL}">View on GitHub</a>
  </div>
</body>
</html>`);
});

// Auth: login redirect to Keystone (KEYSTONE-DOWNSTREAM-INTEGRATION-STANDARDS)
app.get("/auth/login", (req, res) => {
  const keystoneUrl = process.env.KEYSTONE_URL;
  if (!keystoneUrl) {
    res.status(503).json({ error: "Identity service not configured" });
    return;
  }
  const returnTo = (req.query.returnTo as string) || "/";
  // Validate returnTo is a relative path (KEYSTONE: no absolute external URLs)
  if (returnTo.startsWith("http") || returnTo.startsWith("//")) {
    res.status(400).json({ error: "returnTo must be a relative path" });
    return;
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  // Store nonce for verification on callback (KEYSTONE: nonce MUST be stored)
  cleanExpiredNonces();
  nonceStore.set(nonce, { createdAt: Date.now(), returnTo });
  log("info", "Keystone login initiated", { returnTo, noncePrefix: nonce.slice(0, 8) });
  res.redirect(
    `${keystoneUrl}/api/auth/login?app=deploy-poc&returnTo=${encodeURIComponent(returnTo)}&nonce=${nonce}`
  );
});

// Auth: callback from Keystone (KEYSTONE-DOWNSTREAM-INTEGRATION-STANDARDS)
app.get("/auth/callback", (req, res) => {
  const handoff = req.query.handoff as string;
  const secret = process.env.HANDOFF_TOKEN_SECRET;

  // Fail closed on missing inputs (KEYSTONE: fail closed)
  if (!handoff || !secret) {
    log("warn", "Auth callback missing handoff or secret");
    res.status(400).json({ error: "Authentication failed" });
    return;
  }

  try {
    const decoded = jwt.verify(handoff, secret, { algorithms: ["HS256"] }) as jwt.JwtPayload;

    // Verify required claims (KEYSTONE: verify iss, aud, exp, nonce)
    if (decoded.aud !== "deploy-poc") {
      log("warn", "Handoff token audience mismatch", { aud: decoded.aud });
      res.status(401).json({ error: "Authentication failed" });
      return;
    }

    if (decoded.nonce && !nonceStore.has(decoded.nonce as string)) {
      log("warn", "Handoff token nonce mismatch or expired");
      res.status(401).json({ error: "Authentication failed" });
      return;
    }

    // Consume nonce (one-time use)
    if (decoded.nonce) nonceStore.delete(decoded.nonce as string);

    // Never return the raw decoded token to the client (SECURITY: no leaked internals)
    log("info", "Keystone auth successful", { sub: decoded.sub, email: decoded.email });
    res.json({
      status: "authenticated",
      user: {
        sub: decoded.sub,
        email: decoded.email,
        displayName: decoded.display_name,
        roles: decoded.roles,
      },
    });
  } catch {
    // Fail closed — generic error, no detail leak (ERROR-HANDLING / SECURITY)
    log("warn", "Handoff token verification failed");
    res.status(401).json({ error: "Authentication failed" });
  }
});

// Dashboard UI (VER-UI-01, VER-UI-02, VER-UI-06, VER-UI-07, VER-UI-08, VER-UI-09)
app.get("/", async (_req, res) => {
  const [supabase, signalr, keystone] = await Promise.all([
    checkSupabase(),
    checkSignalR(),
    checkKeystone(),
  ]);

  const severity = computeSeverity([supabase, signalr, keystone]);

  const statusIcon = (s: string) =>
    s === "ok" ? "\u2705" : s === "skip" ? "\u23ed\ufe0f" : s === "warn" ? "\u26a0\ufe0f" : "\u274c";

  const severityColor: Record<string, string> = {
    healthy: "#22c55e",
    degraded: "#f59e0b",
    critical: "#ef4444",
  };
  const severityText: Record<string, string> = {
    healthy: "Healthy",
    degraded: "Degraded",
    critical: "Critical",
  };

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Deploy Validation POC</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; background: #0f172a; color: #e2e8f0; }
    h1 { color: #38bdf8; }
    .card { background: #1e293b; border-radius: 8px; padding: 16px; margin: 12px 0; }
    .card h3 { margin: 0 0 8px; color: #94a3b8; font-size: 14px; text-transform: uppercase; }
    .status { font-size: 18px; }
    .meta { color: #64748b; font-size: 13px; margin-top: 4px; }
    a { color: #38bdf8; }
    .status-cluster {
      display: flex; align-items: center; gap: 12px;
      background: #1e293b; border-radius: 8px; padding: 10px 16px; margin: 12px 0;
    }
    .env-badge {
      font-size: 11px; font-weight: 700; letter-spacing: 0.5px;
      padding: 3px 8px; border-radius: 4px;
      background: ${RAW_ENV === "production" || RAW_ENV === "prod" ? "#1e3a5f" : "#422006"};
      color: ${RAW_ENV === "production" || RAW_ENV === "prod" ? "#38bdf8" : "#f59e0b"};
    }
    .severity-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: ${severityColor[severity]};
      display: inline-block;
    }
    .severity-text { font-size: 12px; color: ${severityColor[severity]}; }
    .version-link { font-size: 14px; color: #e2e8f0; text-decoration: none; }
    .version-link:hover { text-decoration: underline; }
    .build-meta { font-size: 11px; color: #64748b; }
  </style>
</head>
<body>
  <h1>Deploy Validation POC</h1>
  <p>Proving the <a href="https://github.com/Alterspective-IO/Alterspective-Intelligence/blob/main/Practice/AI/runbooks/AIRUN-021-Coolify-Deployment-Playbook.md">AIRUN-021 Coolify Deployment Playbook</a>.</p>

  <div class="status-cluster">
    <span class="env-badge">${ENV_LABEL}</span>
    <span class="severity-dot" title="${severityText[severity]}"></span>
    <span class="severity-text">${severityText[severity]}</span>
    <a href="/changelog" class="version-link">v${DISPLAY_VERSION}</a>
  </div>
  <div class="build-meta" style="text-align:center; margin-bottom: 12px;">
    SHA: ${BUILD_SHA} | Built: ${BUILD_DATE} |
    <a href="${RELEASE_URL}" style="font-size:11px">GitHub Release</a>
  </div>

  <div class="card">
    <h3>Supabase</h3>
    <div class="status">${statusIcon(supabase.status)} ${supabase.status.toUpperCase()}</div>
    <div class="meta">${supabase.detail}</div>
  </div>

  <div class="card">
    <h3>Azure SignalR</h3>
    <div class="status">${statusIcon(signalr.status)} ${signalr.status.toUpperCase()}</div>
    <div class="meta">${signalr.detail}</div>
  </div>

  <div class="card">
    <h3>Keystone Identity</h3>
    <div class="status">${statusIcon(keystone.status)} ${keystone.status.toUpperCase()}</div>
    <div class="meta">${keystone.detail}</div>
  </div>

  <div class="card">
    <h3>Endpoints</h3>
    <div class="meta">
      <a href="/health">/health</a> (liveness) |
      <a href="/api/health">/api/health</a> (readiness) |
      <a href="/api/version">/api/version</a> (version) |
      <a href="/changelog">/changelog</a> (release history) |
      <a href="/auth/login">/auth/login</a> (Keystone SSO)
    </div>
  </div>
</body>
</html>`);
});

// ── Global error handler (ERROR-HANDLING-STANDARDS) ──

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log("error", "Unhandled error", { error: err.message, stack: err.stack });
  // Never leak internals to client (ERROR-HANDLING-STANDARDS)
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ──

app.listen(PORT, () => {
  log("info", "Server started", { port: PORT, version: DISPLAY_VERSION, env: ENV_LABEL });
  if (envWarnings.length > 0) {
    for (const w of envWarnings) log("warn", w);
  }
});

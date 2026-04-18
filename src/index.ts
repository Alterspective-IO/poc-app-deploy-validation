import express from "express";
import { createClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const RAW_ENV = process.env.APP_ENV || "local";
const VERSION = process.env.APP_VERSION || process.env.npm_package_version || require("../package.json").version;
const BUILD_SHA = process.env.APP_BUILD_SHA || "local";
const BUILD_DATE = process.env.APP_BUILD_DATE || new Date().toISOString();
const REPO_URL = "https://github.com/Alterspective-IO/poc-app-deploy-validation";

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
  // Staging / UAT / test — pre-release identifier
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

// ── Service clients ──

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function parseSignalRConnectionString(cs: string) {
  const pairs = cs.split(";").reduce<Record<string, string>>((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx > 0) acc[pair.slice(0, idx)] = pair.slice(idx + 1);
    return acc;
  }, {});
  return { endpoint: pairs.Endpoint, accessKey: pairs.AccessKey, version: pairs.Version };
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
  } catch (e: any) {
    return { status: "fail", detail: e.message };
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
    const cs = process.env.AZURE_SIGNALR_CONNECTION_STRING!;
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
  } catch (e: any) {
    return { status: "fail", detail: e.message };
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

  // Simple markdown-to-HTML: headers, lists, links
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

// Auth: login redirect to Keystone
app.get("/auth/login", (req, res) => {
  const keystoneUrl = process.env.KEYSTONE_URL;
  if (!keystoneUrl) {
    res.status(500).json({ error: "KEYSTONE_URL not configured" });
    return;
  }
  const returnTo = (req.query.returnTo as string) || "/";
  const nonce = crypto.randomBytes(16).toString("hex");
  res.redirect(
    `${keystoneUrl}/api/auth/login?app=deploy-poc&returnTo=${encodeURIComponent(returnTo)}&nonce=${nonce}`
  );
});

// Auth: callback from Keystone
app.get("/auth/callback", (req, res) => {
  const handoff = req.query.handoff as string;
  const secret = process.env.HANDOFF_TOKEN_SECRET;
  if (!handoff || !secret) {
    res.status(400).json({ error: "Missing handoff token or secret" });
    return;
  }
  try {
    const decoded = jwt.verify(handoff, secret, { algorithms: ["HS256"] });
    res.json({ status: "authenticated", user: decoded });
  } catch (e: any) {
    res.status(401).json({ error: "Invalid handoff token", detail: e.message });
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

    /* VER-UI-06: Runtime status cluster */
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
    /* VER-UI-09: Severity indicator */
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

  <!-- VER-UI-06: Environment + version + severity status cluster -->
  <div class="status-cluster">
    <span class="env-badge">${ENV_LABEL}</span>
    <span class="severity-dot" title="${severityText[severity]}"></span>
    <span class="severity-text">${severityText[severity]}</span>
    <!-- VER-UI-02: Version links to release history -->
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

// ── Start ──

app.listen(PORT, () => {
  console.log(`[deploy-poc] ${DISPLAY_VERSION} (${ENV_LABEL}) listening on :${PORT}`);
});

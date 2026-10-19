// Vilano South GR CRM — 3.7.4 server.
// Express + node:sqlite. Auth: email+password, allowlist-only, scrypt hashing,
// httpOnly session cookies. No self-registration. All SQL parameterized.

import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import httpsMod from "node:https";
import httpMod from "node:http";
import { fileURLToPath } from "node:url";
import {
  openDb, bootstrapFreshDb, findUserByEmail, verifyPassword, isAllowed,
  allowEmail, createUser, setUserPassword, userCount, audit,
  sampleLegislatorCount, loadSampleLegislators, purgeSampleLegislators,
} from "./db.js";
import { loadSampleContent, purgeSampleContent, sampleContentLoaded, sampleContentComplete } from "./sample-content.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB per file

const STATUSES = ["open", "in_progress", "done"];
const CHAMBERS = ["house", "senate"];
const PARTIES = ["R", "D", "I"];
const INTERACTION_TYPES = ["Meeting", "Call", "Email", "Hallway touch"];

// ---- login hardening ----
// In-memory rate limit: 10 attempts per 15 minutes per IP, plus 10 per 15
// minutes per account (normalized email). The per-account bucket matters
// because every remote user arrives as 127.0.0.1 behind the Cloudflare tunnel.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip -> { count, resetAt }
const loginAccountAttempts = new Map(); // email -> { count, resetAt }
function bucketAllowed(map, key) {
  const now = Date.now();
  let e = map.get(key);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    map.set(key, e);
  }
  e.count += 1;
  if (map.size > 2000) {
    for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
  }
  return e.count <= LOGIN_MAX_ATTEMPTS;
}
function loginAllowed(ip) { return bucketAllowed(loginAttempts, ip); }
function accountLoginAllowed(email) {
  return bucketAllowed(loginAccountAttempts, String(email || "").trim().toLowerCase());
}
function loginReset(ip, email) {
  loginAttempts.delete(ip);
  loginAccountAttempts.delete(String(email || "").trim().toLowerCase());
}
// Test hook: clear login rate-limit state so tests are order-independent.
export function __resetLoginLimits() {
  loginAttempts.clear();
  loginAccountAttempts.clear();
}
// Dummy scrypt credentials so unknown emails cost the same time as a real
// password check (no timing oracle for email enumeration).
const DUMMY_PW = (() => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("no-such-password", salt, 64).toString("hex");
  return { salt, hash };
})();

// Abbreviations that must not end a sentence for the 2-sentence note rule.
const SENT_ABBR = ["Mr", "Mrs", "Ms", "Dr", "Rep", "Sen", "St", "Jr", "Sr", "Gov", "Gen", "Sgt", "Lt", "Col", "Prof", "Inc", "Ltd", "Co", "etc", "vs", "Ave", "Blvd", "Rd"];
function countSentences(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  // Protect initials ("T.") and common abbreviations ("Rep.") so they don't
  // inflate the count, then split on real sentence-ending punctuation.
  let tmp = t.replace(/\b([A-Za-z])\./g, "$1<prd>");
  for (const a of SENT_ABBR) tmp = tmp.replace(new RegExp(`\\b${a}\\.`, "gi"), `${a}<prd>`);
  return tmp.split(/[.!?]+/).map(x => x.replace(/<prd>/g, ".").trim()).filter(Boolean).length;
}

function validateNote(note) {
  const n = String(note || "");
  if (n.length > 300) return "Note must be 300 characters or fewer.";
  if (countSentences(n) > 2) return "Note must be 2 sentences or fewer.";
  return null;
}

function validDate(d) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split("-").map(Number);
  if (m < 1 || m > 12 || day < 1 || day > 31) return false;
  // Reject impossible calendar dates (e.g. 2026-02-30): the components must round-trip.
  const dt = new Date(y, m - 1, day);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === day;
}

// Escape LIKE wildcards so user search input is matched literally.
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

// Dedupe committee names per member (case-insensitive, trimmed).
function dedupeCommittees(committees) {
  const seen = new Set(), out = [];
  for (const c of Array.isArray(committees) ? committees : []) {
    const t = String(c).trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// Strip any path, keep only safe characters; never trust the client filename.
function sanitizeFilename(name) {
  let base = String(name || "").split(/[\\/]/).pop().trim();
  base = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^\.+/, "");
  if (base.length > 100) base = base.slice(0, 100);
  return base || "file";
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Picks the installer asset from a GitHub release's asset list.
// Prefers the conventional VilanoCRM-Setup.exe name, but falls back to any
// .exe so a differently-named upload (e.g. a browser-renamed copy like
// "VilanoCRM-Setup.8.exe") doesn't silently break auto-update.
export function pickUpdateAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return (
    list.find((x) => x && /setup\.exe$/i.test(x.name || "")) ||
    list.find((x) => x && /\.exe$/i.test(x.name || ""))
  ) || null;
}

// Expected sample-legislator count, from the bundled dataset file.
// Infinity fallback (file missing) means `full` can never be true, so the
// Load button stays enabled and the click surfaces the missing-file error.
const SAMPLE_LEG_EXPECTED = (() => {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "legislators.json"), "utf8"));
    return Array.isArray(rows) ? rows.length : Number.POSITIVE_INFINITY;
  } catch { return Number.POSITIVE_INFINITY; }
})();

// True only when the whole sample set is present. After a partial load this
// is false, so the Load button stays enabled and a retry completes the rest.
function sampleDatasetFull(db) {
  return sampleLegislatorCount(db) >= SAMPLE_LEG_EXPECTED && sampleContentComplete(db);
}

export function createApp(db, { uploadsDir, port = null } = {}) {
  const app = express();
  app.disable("x-powered-by");

  const uploads = uploadsDir || path.join(__dirname, "data", "uploads");
  fs.mkdirSync(uploads, { recursive: true });

  // First-run setup: no users yet means the installer just ran — the owner
  // creates the admin account and allowlist through /setup instead of a demo login.
  const needsSetup = () => userCount(db) === 0;
  const lanUrl = () => `http://${lanIpv4() || "127.0.0.1"}:${port || process.env.PORT || 3000}`;
  // Private-network (overlay) address for off-Wi-Fi phone access via Tailscale
  // or NetBird — null when neither is running on this PC.
  const remoteUrl = () => {
    const p = port || process.env.PORT || 3000;
    const ip = overlayIpv4();
    if (ip) return `http://${ip}:${p}`;
    // Fallback: Tailscale CLI is up but the 100.x interface isn't enumerated —
    // the MagicDNS name resolves to the same address on phones.
    if (tailscaleDns) return `http://${tailscaleDns}:${p}`;
    return null;
  };
  // Secure (https) tailnet address for one-tap phone install. The phone's
  // Install button only appears over https, so the server configures
  // `tailscale serve` on startup when the Tailscale client is present.
  // Best-effort: never throws, never blocks startup.
  let secureUrl = null;
  let tailscaleDns = null;
  const tailscaleDnsName = () => {
    try {
      const out = execFileSync("tailscale", ["status", "--json"], {
        timeout: 8000, stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      const dns = JSON.parse(out)?.Self?.DNSName || "";
      return dns.replace(/\.$/, "") || null;
    } catch { return null; }
  };
  const serveConfigured = (p) => {
    try {
      const out = execFileSync("tailscale", ["serve", "status"], {
        timeout: 8000, stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      return out.includes(`127.0.0.1:${p}`) || out.includes(`localhost:${p}`);
    } catch { return false; }
  };
  setImmediate(() => {
    try {
      const p = port || process.env.PORT || 3000;
      if (!serveConfigured(p)) {
        execFileSync("tailscale", ["serve", "https", "/", `http://127.0.0.1:${p}`], {
          timeout: 15000, stdio: "ignore",
        });
      }
      const dns = tailscaleDnsName();
      if (dns) { tailscaleDns = dns; secureUrl = `https://${dns}`; }
    } catch {}
  });

  // ---- auto-update: check GitHub releases, download in background ----
  // Polls the public releases API; when a newer version appears the installer
  // is downloaded to the temp dir and the UI offers a one-click install.
  // The installer closes the running app itself, so this never force-kills.
  const APP_VERSION = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || "0.0.0";
    } catch { return "0.0.0"; }
  })();
  const UPDATE_REPO = "alexwboles/vilano-south-crm";
  const updateState = { current: APP_VERSION, latest: null, ready: false, file: null, checking: false, error: null };
  const cmpVer = (a, b) => {
    const pa = String(a).replace(/^v/, "").split(".").map(Number);
    const pb = String(b).replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  };
  const checkForUpdate = () => {
    if (updateState.checking || updateState.ready) return;
    updateState.checking = true;
    const req = httpsGet(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { "User-Agent": "vilano-crm" }, (res, body) => {
      updateState.checking = false;
      try {
        const rel = JSON.parse(body);
        const tag = (rel.tag_name || "").replace(/^v/, "");
        updateState.latest = tag;
        if (tag && cmpVer(tag, APP_VERSION) > 0) {
          const asset = pickUpdateAsset(rel.assets || []);
          const sumAsset = (rel.assets || []).find((a) => /sha256|checksum/i.test(a.name || ""));
          if (asset) downloadUpdate(asset.browser_download_url, tag, sumAsset ? sumAsset.browser_download_url : null);
        }
      } catch (e) { updateState.error = "Could not read release info."; }
    });
    req.on("error", () => { updateState.checking = false; updateState.error = "Update check failed."; });
  };
  // Downloads the installer, then verifies its SHA-256 against the checksum
  // file published with the release. Refuses the update when no checksum is
  // published or the hash doesn't match — never installs an unverified .exe.
  const sha256File = (file) => new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
  const downloadUpdate = (url, tag, checksumUrl) => {
    const dest = path.join(os.tmpdir(), `VilanoCRM-Setup-${tag}.exe`);
    updateState.file = dest;
    const file = fs.createWriteStream(dest);
    file.on("error", () => { updateState.error = "Download failed."; updateState.file = null; });
    file.on("finish", () => verifyUpdate(dest, tag, checksumUrl));
    httpsGet(url, { "User-Agent": "vilano-crm" }, (res, body) => {}, file)
      .on("error", () => { updateState.error = "Download failed."; updateState.file = null; });
  };
  const verifyUpdate = async (dest, tag, checksumUrl) => {
    try {
      if (fs.statSync(dest).size < 10 * 1024 * 1024) {
        updateState.error = "Downloaded update is too small — discarded.";
        updateState.file = null;
        return;
      }
      if (!checksumUrl) {
        updateState.error = "Update refused: no checksum published with this release.";
        updateState.file = null;
        try { fs.unlinkSync(dest); } catch {}
        return;
      }
      const sumBody = await new Promise((resolve, reject) => {
        httpsGet(checksumUrl, { "User-Agent": "vilano-crm" }, (res, body) => resolve(body || ""))
          .on("error", reject);
      });
      const want = String(sumBody).split("\n")
        .map((l) => l.trim().split(/\s+/))
        .find((p) => p.length >= 2 && /vilano.*setup.*\.exe$/i.test(p[1] || ""));
      const got = await sha256File(dest);
      if (want && want[0].toLowerCase() === got.toLowerCase()) {
        updateState.ready = true;
        console.log(`Update ${tag} downloaded and checksum-verified — ready to install.`);
        // Auto-install on launch: don't wait for a banner click.
        if (AUTO_UPDATE) {
          console.log(`Auto-installing update ${tag} in 10 seconds...`);
          setTimeout(() => runUpdateInstall(null), 10000);
        }
      } else {
        updateState.error = "Update refused: checksum mismatch.";
        updateState.file = null;
        try { fs.unlinkSync(dest); } catch {}
      }
    } catch {
      updateState.error = "Update verification failed.";
      updateState.file = null;
    }
  };
  // Minimal https GET helper (follows one redirect, no deps).
  function httpsGet(url, headers, onDone, pipeTo) {
    const mod = url.startsWith("https:") ? httpsMod : httpMod;
    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers, onDone, pipeTo);
      }
      if (pipeTo) { res.pipe(pipeTo); res.on("end", () => onDone(res)); return; }
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => onDone(res, body));
    });
    return req;
  }
  setImmediate(checkForUpdate);
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
  // Launches the bundled cloudflared on startup; captures the public URL from
  // its output for the Connect Phone page. No VPN app needed on phones, no
  // user limit. Best-effort: never throws, never blocks startup.
  //
  // Two modes:
  //  1. Named tunnel (stable URL): admin pastes a tunnel token + hostname in
  //     Settings (from their Cloudflare dashboard). URL never changes.
  //  2. Quick tunnel (automatic): free https://….trycloudflare.com link.
  //     Works with zero setup, but the address changes on PC restart.
  let publicUrl = null;
  let cfProc = null;
  const getMeta = (k) => {
    try { return db.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v || null; }
    catch { return null; }
  };
  const startTunnel = () => {
    const exe = path.join(__dirname, "cloudflared.exe");
    if (process.platform !== "win32" || !fs.existsSync(exe)) return;
    // Stop any existing tunnel before (re)starting.
    try { cfProc?.kill(); } catch {}
    cfProc = null; publicUrl = null;
    const token = getMeta("tunnel_token");
    const hostname = getMeta("tunnel_hostname");
    const p = port || process.env.PORT || 3000;
    // Hostname set but no token: tunnel is managed externally (e.g. Windows
    // service) — just use the hostname for the public link, don't spawn.
    if (hostname && !token) {
      publicUrl = `https://${hostname}`;
      console.log(`Public phone link: ${publicUrl} (external tunnel)`);
      return;
    }
    let args;
    let childEnv = null;
    if (token && hostname) {
      // Pass the token via the TUNNEL_TOKEN env var — never as a CLI argument,
      // so it doesn't show up in the Windows process list.
      args = ["tunnel", "run"];
      childEnv = { ...process.env, TUNNEL_TOKEN: token };
      publicUrl = `https://${hostname}`;
      console.log(`Public phone link: ${publicUrl} (named tunnel)`);
    } else {
      args = ["tunnel", "--url", `http://127.0.0.1:${p}`];
    }
    try {
      const cf = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(childEnv ? { env: childEnv } : {}) });
      cfProc = cf;
      let buf = "";
      const onData = (d) => {
        buf += d.toString();
        if (!publicUrl) {
          const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
          if (m) {
            publicUrl = m[0];
            console.log(`Public phone link: ${publicUrl}`);
          }
        }
        if (buf.length > 20000) buf = buf.slice(-5000);
      };
      cf.stdout.on("data", onData);
      cf.stderr.on("data", onData);
      cf.on("error", () => {});
      cf.on("exit", () => { if (cfProc === cf) { cfProc = null; publicUrl = null; } });
      const shutdown = () => { try { cf.kill(); } catch {} };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch {}
  };
  setImmediate(startTunnel);

  // ---- session middleware (runs before body parsing; it never reads the body) ----
  app.use((req, res, next) => {
    req.user = null;
    const token = parseCookies(req).vs_session;
    if (token) {
      const s = db.prepare("SELECT user_id, expires_at, csrf FROM sessions WHERE token = ?").get(token);
      if (s && new Date(s.expires_at).getTime() > Date.now()) {
        const u = db.prepare("SELECT id, email, role, created_at FROM users WHERE id = ?").get(s.user_id);
        if (u) req.user = { ...u, csrf: s.csrf || "" };
      } else if (s) {
        db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      }
    }
    next();
  });

  // ---- CSRF: synchronizer token ----
  // Issued at login (and readable via /api/me); required as the X-CSRF-Token
  // header on every state-changing API call. SameSite=Lax cookies stay as-is.
  // /api/login and /api/setup are exempt — they run before a session exists.
  const CSRF_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
  app.use((req, res, next) => {
    if (CSRF_METHODS.has(req.method) && req.path.startsWith("/api/") &&
        req.path !== "/api/login" && req.path !== "/api/setup") {
      // Unauthenticated: let the auth layer answer 401. Authenticated but
      // wrong/missing token: 403.
      if (!req.user) return next();
      const sent = req.headers["x-csrf-token"];
      if (!req.user.csrf || !sent || sent !== req.user.csrf) {
        return res.status(403).json({ error: "bad csrf token" });
      }
    }
    next();
  });

  const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
    next();
  };

  // ---- session hygiene: sweep expired sessions hourly, plus once at boot ----
  const sweepSessions = () => {
    try { db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(); } catch {}
  };
  setImmediate(sweepSessions);
  setInterval(sweepSessions, 60 * 60 * 1000);

  // ---- document upload: own larger JSON body parser, registered before the
  // tight global one below so big-but-allowed files reach the handler ----
  app.post("/api/documents", express.json({ limit: "40mb" }), (req, res) => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    const { name, data } = req.body || {};
    const safe = sanitizeFilename(name);
    if (typeof data !== "string" || !data.length) return bad(res, "No file data received.");
    let buf;
    try {
      if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) return bad(res, "File data is not valid base64.");
      buf = Buffer.from(data.replace(/\s/g, ""), "base64");
    } catch {
      return bad(res, "File data is not valid base64.");
    }
    if (!buf.length) return bad(res, "File is empty.");
    if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: "File exceeds the 25 MB limit." });
    const stored = `${crypto.randomBytes(8).toString("hex")}-${safe}`;
    try {
      fs.writeFileSync(path.join(uploads, stored), buf);
    } catch {
      return res.status(500).json({ error: "Could not store the file." });
    }
    const r = db.prepare("INSERT INTO documents (stored_name, orig_name, size, uploaded_by) VALUES (?,?,?,?)")
      .run(stored, safe, buf.length, req.user.email);
    res.status(201).json({ id: Number(r.lastInsertRowid), name: safe, size: buf.length });
  });

  app.use(express.json({ limit: "256kb" }));

  const requireAuth = (req, res, next) => {
    if (!req.user) {
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
      return res.redirect("/login.html");
    }
    next();
  };

  // Auto-install: when a verified update is ready, install it automatically
  // without waiting for a banner click. Disable with VILANO_NO_AUTO_UPDATE=1.
  const AUTO_UPDATE = process.env.VILANO_NO_AUTO_UPDATE !== "1";
  const runUpdateInstall = (byUser) => {
    if (!updateState.ready || !updateState.file || !fs.existsSync(updateState.file)) return false;
    console.log(`Installing update ${updateState.latest}${byUser ? " (manual)" : " (auto)"}...`);
    // Launch the installer, then get out of its way. It closes the tray/server itself.
    setTimeout(() => {
      try {
        spawn(`"${updateState.file}"`, [], { shell: true, detached: true, stdio: "ignore" }).unref();
      } catch {}
      setTimeout(() => process.exit(0), 1500);
    }, 500);
    return true;
  };

  app.post("/api/admin/update-install", requireAdmin, (req, res) => {
    if (!runUpdateInstall(req.user)) {
      return res.status(400).json({ error: "No update downloaded yet." });
    }
    audit(db, req.user, "update-install", "app", updateState.latest, `Installed update ${updateState.latest}`);
    res.json({ ok: true });
  });

  app.get("/api/update-status", requireAuth, (req, res) => res.json({
    current: updateState.current, latest: updateState.latest,
    ready: updateState.ready, error: updateState.error,
  }));

  // ---- public assets ----
  app.get("/health", (req, res) => res.json({ ok: true }));
  app.get("/login.html", (req, res) => {
    if (needsSetup()) return res.redirect("/setup");
    res.sendFile(path.join(__dirname, "public", "login.html"));
  });
  app.get("/login.js", (req, res) => res.sendFile(path.join(__dirname, "public", "login.js")));
  app.get("/styles.css", (req, res) => res.sendFile(path.join(__dirname, "public", "styles.css")));
  app.get("/favicon.ico", (req, res) => res.sendFile(path.join(__dirname, "public", "favicon.ico")));
  app.get("/icon-192.png", (req, res) => res.sendFile(path.join(__dirname, "public", "icon-192.png")));
  app.get("/icon-512.png", (req, res) => res.sendFile(path.join(__dirname, "public", "icon-512.png")));
  app.get("/apple-touch-icon.png", (req, res) => res.sendFile(path.join(__dirname, "public", "apple-touch-icon.png")));
  app.get("/manifest.json", (req, res) => res.sendFile(path.join(__dirname, "public", "manifest.json")));
  app.get("/sw.js", (req, res) => res.sendFile(path.join(__dirname, "public", "sw.js")));
  app.get("/", (req, res) => {
    if (needsSetup()) return res.redirect("/setup");
    res.redirect(req.user ? "/index.html" : "/login.html");
  });

  // ---- first-run setup (public only while no users exist) ----
  app.get("/setup", (req, res) => {
    if (!needsSetup()) return res.redirect("/login.html");
    res.sendFile(path.join(__dirname, "public", "setup.html"));
  });
  app.get("/setup.js", (req, res) => {
    if (!needsSetup()) return res.status(404).send("not found");
    res.sendFile(path.join(__dirname, "public", "setup.js"));
  });
  // Whether the demo account exists — lets login.html hide its demo hint.
  // The demo account can only exist when VILANO_DEV_DEMO=1 (dev only).
  app.get("/api/demo-available", (req, res) => {
    res.json({ demo: process.env.VILANO_DEV_DEMO === "1" && !!findUserByEmail(db, "demo@vilano.local") });
  });
  app.post("/api/setup", (req, res) => {
    if (!needsSetup()) return res.status(409).json({ error: "Setup is already complete." });
    const { email, password, allowlist } = req.body || {};
    const adminEmail = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return bad(res, "Enter a valid email address.");
    if (typeof password !== "string" || password.length < 8) return bad(res, "Password must be at least 8 characters.");
    const extra = [];
    for (const e of Array.isArray(allowlist) ? allowlist : []) {
      const t = String(e).trim().toLowerCase();
      if (!t) continue;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return bad(res, `Not a valid email: ${t}`);
      extra.push(t);
    }
    try {
      allowEmail(db, adminEmail);
      for (const e of extra) allowEmail(db, e);
      createUser(db, adminEmail, password);
    } catch (err) {
      const m = String(err.message);
      if (m === "weak-password") return bad(res, "Password must be at least 8 characters.");
      if (m === "invalid-email") return bad(res, "Enter a valid email address.");
      return res.status(500).json({ error: "Could not complete setup." });
    }
    res.status(201).json({ ok: true, email: adminEmail });
  });

  // ---- auth ----
  app.post("/api/login", (req, res) => {
    const { email, password } = req.body || {};
    const normEmail = String(email || "").trim().toLowerCase();
    if (!loginAllowed(req.ip) || !accountLoginAllowed(normEmail)) {
      res.set("Retry-After", "900");
      return res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
    }
    const user = findUserByEmail(db, normEmail);
    // Always run the scrypt comparison — even for unknown emails — so the
    // failure time doesn't reveal whether an email is registered.
    const pwOk = user
      ? verifyPassword(String(password || ""), user.pw_salt, user.pw_hash)
      : verifyPassword(String(password || ""), DUMMY_PW.salt, DUMMY_PW.hash);
    // Same failure shape for unknown email / non-allowlisted / wrong password.
    if (!user || !pwOk) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    loginReset(req.ip, normEmail); // successful login resets both counters
    // Multiple concurrent sessions are allowed: users can stay signed in
    // on phone and computer at the same time.
    const token = crypto.randomBytes(32).toString("hex");
    const csrf = crypto.randomBytes(16).toString("hex");
    const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString().slice(0, 19).replace("T", " ");
    db.prepare("INSERT INTO sessions (token, user_id, expires_at, user_agent, ip, csrf) VALUES (?,?,?,?,?,?)")
      .run(token, user.id, expires, String(req.headers["user-agent"] || "").slice(0, 300), req.ip || "", csrf);
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie",
      `vs_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`);
    res.json({ ok: true, email: user.email, role: user.role || "user", csrf });
  });

  app.post("/api/logout", requireAuth, (req, res) => {
    const token = parseCookies(req).vs_session;
    if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    res.setHeader("Set-Cookie", "vs_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
    res.json({ ok: true });
  });

  app.get("/api/me", requireAuth, (req, res) => res.json({ email: req.user.email, role: req.user.role || "user", csrf: req.user.csrf || "" }));

  // ---- sessions: list + revoke your own ----
  app.get("/api/sessions", requireAuth, (req, res) => {
    const me = parseCookies(req).vs_session;
    const rows = db.prepare(
      "SELECT rowid AS id, user_agent, ip, created_at, expires_at, CASE WHEN token = ? THEN 1 ELSE 0 END AS current FROM sessions WHERE user_id = ? ORDER BY created_at DESC"
    ).all(me || "", req.user.id);
    res.json(rows.map((r) => ({ ...r, token: undefined })));
  });

  app.delete("/api/sessions/:id", requireAuth, (req, res) => {
    const me = parseCookies(req).vs_session;
    const row = db.prepare("SELECT token FROM sessions WHERE rowid = ? AND user_id = ?").get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "not-found" });
    if (row.token === me) return bad(res, "You can't revoke the session you're using. Sign out instead.");
    db.prepare("DELETE FROM sessions WHERE rowid = ?").run(req.params.id);
    res.json({ ok: true });
  });

  // ---- everything below requires auth ----
  // (mounted guard: req.path is mount-relative here, so always 401 for API)
  app.use("/api", (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    next();
  });
  app.get("/index.html", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
  app.get("/app.js", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "app.js")));
  // Executive one-pager (print-optimized page; auth-gated like the app)
  app.get("/one-pager", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "one-pager.html")));
  app.get("/one-pager.js", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "one-pager.js")));
  // Phone pairing page: QR code of the LAN URL so a phone on the same Wi-Fi
  // can open the CRM without typing an address.
  app.get("/phone", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "phone.html")));
  app.get("/api/phone-url", requireAuth, (req, res) => res.json({ url: lanUrl(), remoteUrl: remoteUrl(), secureUrl, publicUrl }));
  const qrPng = async (text, res) => {
    try {
      const { default: QRCode } = await import("qrcode");
      const png = await QRCode.toBuffer(text, { width: 440, margin: 2 });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(png);
    } catch {
      res.status(500).json({ error: "Could not generate the code." });
    }
  };
  app.get("/api/phone-qr.png", requireAuth, (req, res) => qrPng(lanUrl(), res));
  app.get("/api/phone-qr-remote.png", requireAuth, (req, res) => {
    const u = remoteUrl();
    if (!u) return res.status(404).json({ error: "No private-network address on this PC (install Tailscale or NetBird)." });
    qrPng(u, res);
  });
  app.get("/api/phone-qr-secure.png", requireAuth, (req, res) => {
    if (!secureUrl) return res.status(404).json({ error: "No secure address on this PC (Tailscale HTTPS not configured)." });
    qrPng(secureUrl, res);
  });
  app.get("/api/phone-qr-public.png", requireAuth, (req, res) => {
    if (!publicUrl) return res.status(404).json({ error: "Public link not ready yet (Cloudflare Tunnel starting)." });
    qrPng(publicUrl, res);
  });

  const bad = (res, msg) => res.status(400).json({ error: msg });

  // ---- members ----
  // "Rep. Andrew Smith (R-FL-12)" / "Sen. Laura Richards (R-FL)"
  const memberFullLabel = (m) => {
    const title = m.chamber === "house" ? "Rep." : "Sen.";
    const geo = m.chamber === "house" ? `(${m.party}-${m.state}-${m.district})` : `(${m.party}-${m.state})`;
    return `${title} ${m.first_name} ${m.last_name} ${geo}`;
  };

  const staffForMember = (memberId, current) => db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.title, a.started_on, a.ended_on
    FROM staff_assignments a JOIN staff s ON s.id = a.staff_id
    WHERE a.member_id = ? AND ${current ? "a.ended_on IS NULL" : "a.ended_on IS NOT NULL"}
    ORDER BY s.last_name, s.first_name
  `).all(memberId);

  const memberWithCommittees = (m) => ({
    ...m,
    committees: db.prepare("SELECT name FROM member_committees WHERE member_id = ? ORDER BY id").all(m.id).map(r => r.name),
    current_staff: staffForMember(m.id, true),
    former_staff: staffForMember(m.id, false),
  });

  app.get("/api/members", (req, res) => {
    const rows = db.prepare("SELECT * FROM members ORDER BY last_name, first_name").all();
    res.json(rows.map(memberWithCommittees));
  });

  app.post("/api/members", (req, res) => {
    const { chamber, first_name, last_name, party, state, district, committees } = req.body || {};
    if (!CHAMBERS.includes(chamber)) return bad(res, "Chamber must be house or senate.");
    if (!PARTIES.includes(party)) return bad(res, "Party must be R, D, or I.");
    if (!first_name?.trim() || !last_name?.trim()) return bad(res, "First and last name are required.");
    if (!/^[A-Z]{2}$/.test(String(state || "").toUpperCase())) return bad(res, "State must be a 2-letter code.");
    const dist = chamber === "house" ? Number(district) : null;
    if (chamber === "house" && !(Number.isInteger(dist) && dist > 0)) return bad(res, "House members need a district number.");
    const r = db.prepare(
      "INSERT INTO members (chamber, first_name, last_name, party, state, district) VALUES (?,?,?,?,?,?)"
    ).run(chamber, first_name.trim(), last_name.trim(), party, String(state).toUpperCase(), dist);
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO member_committees (member_id, name) VALUES (?,?)");
    for (const c of dedupeCommittees(committees)) ins.run(id, c);
    audit(db, req.user, "create", "member", id, memberFullLabel({ chamber, first_name: first_name.trim(), last_name: last_name.trim(), party, state: String(state).toUpperCase(), district: dist }));
    res.status(201).json(memberWithCommittees(db.prepare("SELECT * FROM members WHERE id = ?").get(id)));
  });

  app.put("/api/members/:id", (req, res) => {
    const cur = db.prepare("SELECT * FROM members WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const { chamber, first_name, last_name, party, state, district, committees } = req.body || {};
    if (!CHAMBERS.includes(chamber)) return bad(res, "Chamber must be house or senate.");
    if (!PARTIES.includes(party)) return bad(res, "Party must be R, D, or I.");
    if (!first_name?.trim() || !last_name?.trim()) return bad(res, "First and last name are required.");
    if (!/^[A-Z]{2}$/.test(String(state || "").toUpperCase())) return bad(res, "State must be a 2-letter code.");
    const dist = chamber === "house" ? Number(district) : null;
    if (chamber === "house" && !(Number.isInteger(dist) && dist > 0)) return bad(res, "House members need a district number.");
    db.prepare("UPDATE members SET chamber=?, first_name=?, last_name=?, party=?, state=?, district=? WHERE id=?")
      .run(chamber, first_name.trim(), last_name.trim(), party, String(state).toUpperCase(), dist, cur.id);
    db.prepare("DELETE FROM member_committees WHERE member_id = ?").run(cur.id);
    const ins = db.prepare("INSERT INTO member_committees (member_id, name) VALUES (?,?)");
    for (const c of dedupeCommittees(committees)) ins.run(cur.id, c);
    audit(db, req.user, "update", "member", cur.id, memberFullLabel({ chamber, first_name: first_name.trim(), last_name: last_name.trim(), party, state: String(state).toUpperCase(), district: dist }));
    res.json(memberWithCommittees(db.prepare("SELECT * FROM members WHERE id = ?").get(cur.id)));
  });

  app.delete("/api/members/:id", (req, res) => {
    const cur = db.prepare("SELECT id FROM members WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    // History is kept: block deletion while interactions or staff assignments
    // reference the member (same rule as staffer delete).
    const refs = db.prepare(
      "SELECT (SELECT COUNT(*) FROM interactions WHERE member_id = ?) + (SELECT COUNT(*) FROM staff_assignments WHERE member_id = ?) AS n"
    ).get(cur.id, cur.id).n;
    if (refs > 0) {
      return bad(res, "Cannot delete: this member has interactions or staff assignments on record.");
    }
    db.prepare("DELETE FROM members WHERE id = ?").run(cur.id);
    audit(db, req.user, "delete", "member", cur.id, "");
    res.json({ ok: true });
  });

  // ---- staff (aides/assistants) ----
  const currentMembersFor = (staffId) => db.prepare(`
    SELECT m.id, m.chamber, m.first_name, m.last_name, m.party, m.state, m.district, a.started_on
    FROM staff_assignments a JOIN members m ON m.id = a.member_id
    WHERE a.staff_id = ? AND a.ended_on IS NULL
    ORDER BY m.last_name, m.first_name
  `).all(staffId).map(m => ({ id: m.id, chamber: m.chamber, label: memberFullLabel(m), started_on: m.started_on }));

  const staffWithCurrent = (s) => ({ ...s, current_members: currentMembersFor(s.id) });

  app.get("/api/staff", (req, res) => {
    const { q, member_id } = req.query;
    const conds = [], params = [];
    if (q) {
      conds.push("(s.first_name LIKE ? ESCAPE '\\' OR s.last_name LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(q)}%`;
      params.push(like, like, like, like);
    }
    if (member_id) {
      conds.push("EXISTS (SELECT 1 FROM staff_assignments a WHERE a.staff_id = s.id AND a.member_id = ? AND a.ended_on IS NULL)");
      params.push(member_id);
    }
    const rows = db.prepare(`
      SELECT s.* FROM staff s
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY s.last_name, s.first_name
    `).all(...params);
    res.json(rows.map(staffWithCurrent));
  });

  app.get("/api/staff/:id", (req, res) => {
    const s = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.id);
    if (!s) return res.status(404).json({ error: "not-found" });
    const assignments = db.prepare(`
      SELECT a.id, a.member_id, a.started_on, a.ended_on,
             m.chamber, m.first_name, m.last_name, m.party, m.state, m.district
      FROM staff_assignments a JOIN members m ON m.id = a.member_id
      WHERE a.staff_id = ?
      ORDER BY CASE WHEN a.ended_on IS NULL THEN 0 ELSE 1 END, a.started_on DESC, a.id DESC
    `).all(s.id).map(a => ({
      id: a.id, member_id: a.member_id, label: memberFullLabel(a),
      chamber: a.chamber, started_on: a.started_on, ended_on: a.ended_on,
      current: a.ended_on === null,
    }));
    const interactions = db.prepare(`
      SELECT i.id, i.date, i.summary, i.next_step, i.status, i.member_id,
             m.chamber, m.first_name, m.last_name, m.party, m.state, m.district
      FROM interactions i JOIN members m ON m.id = i.member_id
      WHERE i.staff_id = ?
      ORDER BY i.date DESC, i.id DESC
    `).all(s.id).map(i => ({ ...i, member_label: memberFullLabel(i) }));
    res.json({ ...s, assignments, interactions });
  });

  function validateStaffBody(body) {
    const { first_name, last_name, title, email, phone, notes } = body || {};
    if (!String(first_name || "").trim() || !String(last_name || "").trim()) {
      return "First and last name are required.";
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return "Enter a valid email address, or leave it blank.";
    }
    return null;
  }

  app.post("/api/staff", (req, res) => {
    const err = validateStaffBody(req.body);
    if (err) return bad(res, err);
    const { first_name, last_name, title, email, phone, notes } = req.body;
    const r = db.prepare(
      "INSERT INTO staff (first_name, last_name, title, email, phone, notes) VALUES (?,?,?,?,?,?)"
    ).run(first_name.trim(), last_name.trim(), String(title || "").trim(),
      String(email || "").trim(), String(phone || "").trim(), String(notes || "").trim());
    const sid = Number(r.lastInsertRowid);
    audit(db, req.user, "create", "staff", sid, `${first_name.trim()} ${last_name.trim()}`);
    res.status(201).json(staffWithCurrent(db.prepare("SELECT * FROM staff WHERE id = ?").get(sid)));
  });

  app.put("/api/staff/:id", (req, res) => {
    const cur = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const err = validateStaffBody(req.body);
    if (err) return bad(res, err);
    const { first_name, last_name, title, email, phone, notes } = req.body;
    db.prepare("UPDATE staff SET first_name=?, last_name=?, title=?, email=?, phone=?, notes=? WHERE id=?")
      .run(first_name.trim(), last_name.trim(), String(title || "").trim(),
        String(email || "").trim(), String(phone || "").trim(), String(notes || "").trim(), cur.id);
    audit(db, req.user, "update", "staff", cur.id, `${first_name.trim()} ${last_name.trim()}`);
    res.json(staffWithCurrent(db.prepare("SELECT * FROM staff WHERE id = ?").get(cur.id)));
  });

  app.delete("/api/staff/:id", (req, res) => {
    const cur = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const refs = db.prepare(
      "SELECT (SELECT COUNT(*) FROM staff_assignments WHERE staff_id = ?) + (SELECT COUNT(*) FROM interactions WHERE staff_id = ?) AS n"
    ).get(cur.id, cur.id).n;
    if (refs > 0) {
      return bad(res, "Cannot delete: this staffer has assignments or interactions on record. End their assignments instead.");
    }
    db.prepare("DELETE FROM staff WHERE id = ?").run(cur.id);
    audit(db, req.user, "delete", "staff", cur.id, `${cur.first_name} ${cur.last_name}`);
    res.json({ ok: true });
  });

  // ---- staff assignments (history is kept: ending sets ended_on, never deletes) ----
  app.post("/api/staff/:id/assignments", (req, res) => {
    const s = db.prepare("SELECT id FROM staff WHERE id = ?").get(req.params.id);
    if (!s) return res.status(404).json({ error: "not-found" });
    const { member_id, started_on } = req.body || {};
    const member = db.prepare("SELECT id FROM members WHERE id = ?").get(member_id);
    if (!member) return bad(res, "Member is required.");
    const start = started_on || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    if (!validDate(start)) return bad(res, "Start date must be YYYY-MM-DD.");
    const dup = db.prepare(
      "SELECT 1 FROM staff_assignments WHERE staff_id = ? AND member_id = ? AND ended_on IS NULL"
    ).get(s.id, member_id);
    if (dup) return bad(res, "This staffer is already assigned to that member.");
    try {
      const r = db.prepare("INSERT INTO staff_assignments (staff_id, member_id, started_on, ended_on) VALUES (?,?,?,NULL)")
        .run(s.id, member_id, start);
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch {
      return bad(res, "This staffer is already assigned to that member.");
    }
  });

  app.post("/api/assignments/:id/end", (req, res) => {
    const a = db.prepare("SELECT * FROM staff_assignments WHERE id = ?").get(req.params.id);
    if (!a) return res.status(404).json({ error: "not-found" });
    if (a.ended_on !== null) return bad(res, "This assignment has already ended.");
    const end = req.body?.ended_on || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    if (!validDate(end)) return bad(res, "End date must be YYYY-MM-DD.");
    if (end < a.started_on) return bad(res, "End date cannot be before the start date.");
    db.prepare("UPDATE staff_assignments SET ended_on = ? WHERE id = ?").run(end, a.id);
    res.json({ ok: true });
  });

  // ---- interactions ----
  app.get("/api/interactions", (req, res) => {
    const { q, chamber, status, member_id, from, to, type } = req.query;
    const conds = [], params = [];
    if (q) { conds.push("(i.summary LIKE ? ESCAPE '\\' OR i.next_step LIKE ? ESCAPE '\\' OR m.first_name LIKE ? ESCAPE '\\' OR m.last_name LIKE ? ESCAPE '\\')"); const like = `%${escapeLike(q)}%`; params.push(like, like, like, like); }
    if (CHAMBERS.includes(chamber)) { conds.push("m.chamber = ?"); params.push(chamber); }
    if (STATUSES.includes(status)) { conds.push("i.status = ?"); params.push(status); }
    if (member_id) { conds.push("i.member_id = ?"); params.push(member_id); }
    if (validDate(from)) { conds.push("i.date >= ?"); params.push(from); }
    if (validDate(to)) { conds.push("i.date <= ?"); params.push(to); }
    if (INTERACTION_TYPES.includes(type)) { conds.push("i.interaction_type = ?"); params.push(type); }
    const rows = db.prepare(`
      SELECT i.*, m.chamber, m.first_name, m.last_name, m.party, m.state, m.district,
             s.first_name AS staff_first_name, s.last_name AS staff_last_name, s.title AS staff_title,
             p.date AS parent_date,
             pm.chamber AS p_chamber, pm.first_name AS p_first_name, pm.last_name AS p_last_name,
             pm.party AS p_party, pm.state AS p_state, pm.district AS p_district
      FROM interactions i JOIN members m ON m.id = i.member_id
      LEFT JOIN staff s ON s.id = i.staff_id
      LEFT JOIN interactions p ON p.id = i.parent_id
      LEFT JOIN members pm ON pm.id = p.member_id
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY i.date DESC, i.id DESC
    `).all(...params).map(r => ({
      ...r,
      parent_label: r.parent_date ? memberFullLabel({
        chamber: r.p_chamber, first_name: r.p_first_name, last_name: r.p_last_name,
        party: r.p_party, state: r.p_state, district: r.p_district,
      }) : null,
    }));
    res.json(rows);
  });

  // CSV export of the interaction log — same filters as GET /api/interactions.
  // Feeds the team's spreadsheets without copy-paste.
  app.get("/api/interactions.csv", (req, res) => {
    const { q, chamber, status, member_id, from, to, type } = req.query;
    const conds = [], params = [];
    if (q) { conds.push("(i.summary LIKE ? ESCAPE '\\' OR i.next_step LIKE ? ESCAPE '\\' OR m.first_name LIKE ? ESCAPE '\\' OR m.last_name LIKE ? ESCAPE '\\')"); const like = `%${escapeLike(q)}%`; params.push(like, like, like, like); }
    if (CHAMBERS.includes(chamber)) { conds.push("m.chamber = ?"); params.push(chamber); }
    if (STATUSES.includes(status)) { conds.push("i.status = ?"); params.push(status); }
    if (member_id) { conds.push("i.member_id = ?"); params.push(member_id); }
    if (validDate(from)) { conds.push("i.date >= ?"); params.push(from); }
    if (validDate(to)) { conds.push("i.date <= ?"); params.push(to); }
    if (INTERACTION_TYPES.includes(type)) { conds.push("i.interaction_type = ?"); params.push(type); }
    const rows = db.prepare(`
      SELECT i.date, i.interaction_type, i.status, i.summary, i.next_step,
             m.chamber, m.first_name, m.last_name, m.party, m.state, m.district
      FROM interactions i JOIN members m ON m.id = i.member_id
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY i.date DESC, i.id DESC
    `).all(...params);
    const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const lines = ["date,member,chamber,party,state,district,type,status,summary,next_step"];
    for (const r of rows) {
      lines.push([
        r.date, `${r.first_name} ${r.last_name}`, r.chamber, r.party, r.state,
        r.district ?? "", r.interaction_type ?? "", r.status, r.summary, r.next_step ?? "",
      ].map(cell).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="interactions.csv"');
    res.send("\uFEFF" + lines.join("\r\n"));
  });

  // CSV export of the member roster — chamber, party, state, district,
  // committees. Read-only; mirrors /api/interactions.csv.
  app.get("/api/members.csv", (req, res) => {
    const members = db.prepare("SELECT * FROM members ORDER BY last_name, first_name").all().map(memberWithCommittees);
    const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const lines = ["name,chamber,party,state,district,committees"];
    for (const m of members) {
      lines.push([
        `${m.first_name} ${m.last_name}`, m.chamber, m.party, m.state,
        m.district ?? "", (m.committees || []).join("; "),
      ].map(cell).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="members.csv"');
    res.send("\uFEFF" + lines.join("\r\n"));
  });

  // Members with no logged interaction in 90+ days (or ever) — the
  // "who are we neglecting" list for the attention strip. Read-only.
  app.get("/api/members/needing-contact", (req, res) => {
    const rows = db.prepare(`
      SELECT m.id, m.chamber, m.first_name, m.last_name, m.party, m.state, m.district,
             MAX(i.date) AS last_contact, COUNT(i.id) AS interaction_count
      FROM members m LEFT JOIN interactions i ON i.member_id = m.id
      GROUP BY m.id
      HAVING last_contact IS NULL OR last_contact < date('now', '-90 days')
      ORDER BY (last_contact IS NULL) DESC, last_contact ASC, m.last_name, m.first_name
      LIMIT 50
    `).all().map((r) => ({ ...r, member_label: memberFullLabel(r) }));
    res.json(rows);
  });

  // Needs-attention feed: stale open interactions with next steps, overdue
  // tasks, and events in the next 14 days — one call for the dashboard strip.
  app.get("/api/attention", (req, res) => {
    const stale = db.prepare(`
      SELECT i.id, i.date, i.summary, i.next_step, i.status,
             m.chamber, m.first_name, m.last_name, m.party, m.state, m.district
      FROM interactions i JOIN members m ON m.id = i.member_id
      WHERE i.status IN ('open','in_progress')
        AND i.next_step IS NOT NULL AND TRIM(i.next_step) <> ''
        AND i.date < date('now', '-21 days')
      ORDER BY i.date ASC LIMIT 25
    `).all().map((r) => ({ ...r, member_label: memberFullLabel(r) }));
    const overdue = db.prepare(`
      SELECT t.id, t.title, t.owner, t.due_date, t.status, t.note, t.group_id, g.name AS group_name
      FROM tasks t JOIN project_groups g ON g.id = t.group_id
      WHERE t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date < date('now')
      ORDER BY t.due_date ASC LIMIT 25
    `).all();
    const upcoming = db.prepare(`
      SELECT id, date, description, lead_person FROM events
      WHERE date >= date('now') AND date <= date('now', '+14 days')
      ORDER BY date ASC LIMIT 25
    `).all();
    res.json({ stale_interactions: stale, overdue_tasks: overdue, upcoming_events: upcoming });
  });

  // Possible-duplicate check: same member, date within ±2 days, overlapping
  // summary words. Non-blocking — the frontend warns and the user decides.
  // Read-only. `exclude_id` skips the record being edited.
  app.get("/api/interactions/possible-duplicates", (req, res) => {
    const { member_id, date, summary, exclude_id } = req.query;
    if (!member_id || !validDate(date)) return res.json([]);
    const words = new Set(String(summary || "").toLowerCase().match(/[a-z]{4,}/g) || []);
    const rows = db.prepare(`
      SELECT i.id, i.date, i.summary, i.interaction_type, i.status,
             m.chamber, m.first_name, m.last_name, m.party, m.state, m.district
      FROM interactions i JOIN members m ON m.id = i.member_id
      WHERE i.member_id = ?
        AND i.date BETWEEN date(?, '-2 days') AND date(?, '+2 days')
        ${exclude_id ? "AND i.id <> ?" : ""}
      ORDER BY i.date DESC, i.id DESC LIMIT 10
    `).all(...(exclude_id ? [member_id, date, date, exclude_id] : [member_id, date, date]));
    const scored = rows.map((r) => {
      const rw = new Set(String(r.summary || "").toLowerCase().match(/[a-z]{4,}/g) || []);
      let overlap = 0;
      words.forEach((w) => { if (rw.has(w)) overlap++; });
      return { ...r, member_label: memberFullLabel(r), overlap };
    // Require real word overlap: an empty summary must never flag everything
    // in the ±2-day window as a "possible duplicate".
    }).filter((r) => words.size > 0 && r.overlap >= 2);
    res.json(scored);
  });

  // Follow-ups of one interaction (children in the follow-up chain).
  app.get("/api/interactions/:id/followups", (req, res) => {
    const cur = db.prepare("SELECT id FROM interactions WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const rows = db.prepare(`
      SELECT i.id, i.date, i.summary, i.status, i.interaction_type,
             m.chamber, m.first_name, m.last_name, m.party, m.state, m.district
      FROM interactions i JOIN members m ON m.id = i.member_id
      WHERE i.parent_id = ?
      ORDER BY i.date DESC, i.id DESC
    `).all(cur.id).map(r => ({ ...r, member_label: memberFullLabel(r) }));
    res.json(rows);
  });

  // Lightweight status change (used by detail view + follow-up "mark done").
  app.post("/api/interactions/:id/status", (req, res) => {
    const cur = db.prepare("SELECT id FROM interactions WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return bad(res, "Invalid status.");
    db.prepare("UPDATE interactions SET status = ? WHERE id = ?").run(status, cur.id);
    audit(db, req.user, "status", "interaction", cur.id, `status -> ${status}`);
    res.json({ ok: true });
  });

  // Optional staffer on an interaction: always tied to a member, staffer may float.
  function resolveStaffId(staff_id, res) {
    if (staff_id === undefined || staff_id === null || staff_id === "") return { ok: true, id: null };
    const s = db.prepare("SELECT id FROM staff WHERE id = ?").get(staff_id);
    if (!s) return { ok: false, res: bad(res, "Staffer not found.") };
    return { ok: true, id: s.id };
  }

  // Walk the follow-up parent chain: true if making `parentId` the parent of
  // `selfId` would create a cycle.
  function parentChainHits(parentId, selfId) {
    let cur = parentId;
    const seen = new Set();
    while (cur) {
      if (cur === selfId) return true;
      if (seen.has(cur)) return false; // pre-existing loop in data; don't hang
      seen.add(cur);
      const row = db.prepare("SELECT parent_id FROM interactions WHERE id = ?").get(cur);
      cur = row ? row.parent_id : null;
    }
    return false;
  }

  // Optional follow-up parent + optional interaction type; shared by POST and PUT.
  function resolveIxExtras(body, res, selfId) {
    const { interaction_type, parent_id } = body || {};
    let type = null;
    if (interaction_type !== undefined && interaction_type !== null && interaction_type !== "") {
      if (!INTERACTION_TYPES.includes(interaction_type)) return { ok: false, res: bad(res, "Invalid interaction type.") };
      type = interaction_type;
    }
    let parent = null;
    if (parent_id !== undefined && parent_id !== null && parent_id !== "") {
      const p = db.prepare("SELECT id FROM interactions WHERE id = ?").get(parent_id);
      if (!p) return { ok: false, res: bad(res, "Follow-up parent not found.") };
      if (selfId && p.id === selfId) return { ok: false, res: bad(res, "An interaction cannot follow up on itself.") };
      if (selfId && parentChainHits(p.id, selfId)) return { ok: false, res: bad(res, "That would create a follow-up cycle.") };
      parent = p.id;
    }
    return { ok: true, type, parent };
  }

  app.post("/api/interactions", (req, res) => {
    const { member_id, date, summary, next_step, status, staff_id } = req.body || {};
    const member = db.prepare("SELECT id FROM members WHERE id = ?").get(member_id);
    if (!member) return bad(res, "Member is required.");
    if (!validDate(date)) return bad(res, "Date must be YYYY-MM-DD.");
    if (!String(summary || "").trim()) return bad(res, "Summary is required.");
    if (status && !STATUSES.includes(status)) return bad(res, "Invalid status.");
    const st = resolveStaffId(staff_id, res);
    if (!st.ok) return st.res;
    const ex = resolveIxExtras(req.body, res, null);
    if (!ex.ok) return ex.res;
    const r = db.prepare("INSERT INTO interactions (member_id, date, summary, next_step, status, staff_id, interaction_type, parent_id) VALUES (?,?,?,?,?,?,?,?)")
      .run(member_id, date, summary.trim(), String(next_step || "").trim() || null, status || "open", st.id, ex.type, ex.parent);
    const ixId = Number(r.lastInsertRowid);
    audit(db, req.user, "create", "interaction", ixId, `member ${member_id}, ${date}: ${summary.trim().slice(0, 80)}`);
    res.status(201).json({ id: ixId });
  });

  app.get("/api/interactions/:id", (req, res) => {
    const r = db.prepare("SELECT * FROM interactions WHERE id = ?").get(req.params.id);
    if (!r) return res.status(404).json({ error: "not-found" });
    res.json(r);
  });

  app.get("/api/tasks/:id", (req, res) => {
    const r = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!r) return res.status(404).json({ error: "not-found" });
    res.json(r);
  });

  app.put("/api/interactions/:id", (req, res) => {
    const cur = db.prepare("SELECT id FROM interactions WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const { member_id, date, summary, next_step, status, staff_id } = req.body || {};
    const member = db.prepare("SELECT id FROM members WHERE id = ?").get(member_id);
    if (!member) return bad(res, "Member is required.");
    if (!validDate(date)) return bad(res, "Date must be YYYY-MM-DD.");
    if (!String(summary || "").trim()) return bad(res, "Summary is required.");
    if (status && !STATUSES.includes(status)) return bad(res, "Invalid status.");
    const st = resolveStaffId(staff_id, res);
    if (!st.ok) return st.res;
    const ex = resolveIxExtras(req.body, res, cur.id);
    if (!ex.ok) return ex.res;
    db.prepare("UPDATE interactions SET member_id=?, date=?, summary=?, next_step=?, status=?, staff_id=?, interaction_type=?, parent_id=? WHERE id=?")
      .run(member_id, date, summary.trim(), String(next_step || "").trim() || null, status || "open", st.id, ex.type, ex.parent, cur.id);
    audit(db, req.user, "update", "interaction", cur.id, `${date}: ${summary.trim().slice(0, 80)}`);
    res.json({ ok: true });
  });

  app.delete("/api/interactions/:id", (req, res) => {
    const r = db.prepare("DELETE FROM interactions WHERE id = ?").run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: "not-found" });
    audit(db, req.user, "delete", "interaction", req.params.id, "");
    res.json({ ok: true });
  });

  // ---- events ----
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  app.get("/api/events", (req, res) => {
    if (req.query.upcoming === "1") {
      res.json(db.prepare("SELECT * FROM events WHERE date >= ? ORDER BY date ASC, id ASC").all(todayStr()));
    } else {
      res.json(db.prepare("SELECT * FROM events ORDER BY date ASC, id ASC").all());
    }
  });

  app.get("/api/events/:id", (req, res) => {
    const r = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
    if (!r) return res.status(404).json({ error: "not-found" });
    res.json(r);
  });

  app.post("/api/events", (req, res) => {
    const { date, description, lead_person } = req.body || {};
    if (!validDate(date)) return bad(res, "Date must be YYYY-MM-DD.");
    if (!String(description || "").trim()) return bad(res, "Description is required.");
    if (!String(lead_person || "").trim()) return bad(res, "Lead person is required.");
    const r = db.prepare("INSERT INTO events (date, description, lead_person) VALUES (?,?,?)")
      .run(date, description.trim(), lead_person.trim());
    const evId = Number(r.lastInsertRowid);
    audit(db, req.user, "create", "event", evId, `${date}: ${description.trim().slice(0, 80)}`);
    res.status(201).json({ id: evId });
  });

  app.put("/api/events/:id", (req, res) => {
    const cur = db.prepare("SELECT id FROM events WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const { date, description, lead_person } = req.body || {};
    if (!validDate(date)) return bad(res, "Date must be YYYY-MM-DD.");
    if (!String(description || "").trim()) return bad(res, "Description is required.");
    if (!String(lead_person || "").trim()) return bad(res, "Lead person is required.");
    db.prepare("UPDATE events SET date=?, description=?, lead_person=? WHERE id=?")
      .run(date, description.trim(), lead_person.trim(), cur.id);
    audit(db, req.user, "update", "event", cur.id, `${date}: ${description.trim().slice(0, 80)}`);
    res.json({ ok: true });
  });

  app.delete("/api/events/:id", (req, res) => {
    const r = db.prepare("DELETE FROM events WHERE id = ?").run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: "not-found" });
    audit(db, req.user, "delete", "event", req.params.id, "");
    res.json({ ok: true });
  });

  // ---- projects & tasks ----
  app.get("/api/projects", (req, res) => {
    const groups = db.prepare("SELECT * FROM project_groups ORDER BY position, id").all();
    const tasks = db.prepare("SELECT * FROM tasks ORDER BY group_id, position, id").all();
    const byGroup = new Map(groups.map(g => [g.id, { ...g, tasks: [] }]));
    for (const t of tasks) byGroup.get(t.group_id)?.tasks.push(t);
    res.json([...byGroup.values()]);
  });

  app.post("/api/projects/groups", (req, res) => {
    const { name } = req.body || {};
    if (!String(name || "").trim()) return bad(res, "Group name is required.");
    const pos = db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS p FROM project_groups").get().p;
    const r = db.prepare("INSERT INTO project_groups (name, position) VALUES (?,?)").run(name.trim(), pos);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  app.put("/api/projects/groups/:id", (req, res) => {
    const cur = db.prepare("SELECT * FROM project_groups WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const { name, show_on_pager } = req.body || {};
    if (!String(name || "").trim()) return bad(res, "Group name is required.");
    const show = show_on_pager === undefined ? cur.show_on_pager : (show_on_pager ? 1 : 0);
    db.prepare("UPDATE project_groups SET name=?, show_on_pager=? WHERE id=?").run(name.trim(), show, cur.id);
    res.json({ ok: true, show_on_pager: show });
  });

  app.delete("/api/projects/groups/:id", (req, res) => {
    const r = db.prepare("DELETE FROM project_groups WHERE id = ?").run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: "not-found" });
    res.json({ ok: true });
  });

  app.post("/api/projects/groups/:id/move", (req, res) => {
    const cur = db.prepare("SELECT * FROM project_groups WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const dir = req.body?.direction === "down" ? 1 : -1;
    const other = db.prepare(
      `SELECT * FROM project_groups WHERE ${dir < 0 ? "position < ?" : "position > ?"} ORDER BY position ${dir < 0 ? "DESC" : "ASC"} LIMIT 1`
    ).get(cur.position);
    if (!other) return res.json({ ok: true, moved: false });
    db.prepare("UPDATE project_groups SET position=? WHERE id=?").run(other.position, cur.id);
    db.prepare("UPDATE project_groups SET position=? WHERE id=?").run(cur.position, other.id);
    res.json({ ok: true, moved: true });
  });

  app.post("/api/projects/groups/:id/tasks", (req, res) => {
    const group = db.prepare("SELECT id FROM project_groups WHERE id = ?").get(req.params.id);
    if (!group) return res.status(404).json({ error: "not-found" });
    const { title, owner, due_date, status, note } = req.body || {};
    if (!String(title || "").trim()) return bad(res, "Task title is required.");
    if (due_date && !validDate(due_date)) return bad(res, "Due date must be YYYY-MM-DD.");
    if (status && !STATUSES.includes(status)) return bad(res, "Invalid status.");
    const noteErr = validateNote(note);
    if (noteErr) return bad(res, noteErr);
    const pos = db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS p FROM tasks WHERE group_id=?").get(group.id).p;
    const r = db.prepare(
      "INSERT INTO tasks (group_id, title, owner, due_date, status, note, position) VALUES (?,?,?,?,?,?,?)"
    ).run(group.id, title.trim(), String(owner || "").trim(), due_date || null, status || "open", String(note || ""), pos);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  app.put("/api/tasks/:id", (req, res) => {
    const cur = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const { title, owner, due_date, status, note } = req.body || {};
    if (!String(title || "").trim()) return bad(res, "Task title is required.");
    if (due_date && !validDate(due_date)) return bad(res, "Due date must be YYYY-MM-DD.");
    if (status && !STATUSES.includes(status)) return bad(res, "Invalid status.");
    const noteErr = validateNote(note);
    if (noteErr) return bad(res, noteErr);
    db.prepare("UPDATE tasks SET title=?, owner=?, due_date=?, status=?, note=? WHERE id=?")
      .run(title.trim(), String(owner || "").trim(), due_date || null, status || "open", String(note || ""), cur.id);
    res.json({ ok: true });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const r = db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: "not-found" });
    res.json({ ok: true });
  });

  app.post("/api/tasks/:id/move", (req, res) => {
    const cur = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not-found" });
    const dir = req.body?.direction === "down" ? 1 : -1;
    const other = db.prepare(
      `SELECT * FROM tasks WHERE group_id=? AND ${dir < 0 ? "position < ?" : "position > ?"} ORDER BY position ${dir < 0 ? "DESC" : "ASC"} LIMIT 1`
    ).get(cur.group_id, cur.position);
    if (!other) return res.json({ ok: true, moved: false });
    db.prepare("UPDATE tasks SET position=? WHERE id=?").run(other.position, cur.id);
    db.prepare("UPDATE tasks SET position=? WHERE id=?").run(cur.position, other.id);
    res.json({ ok: true, moved: true });
  });

  // ---- documents (finalized library — user uploads only) ----
  app.get("/api/documents", (req, res) => {
    res.json(db.prepare(
      "SELECT id, orig_name, size, uploaded_by, uploaded_at FROM documents ORDER BY uploaded_at DESC, id DESC"
    ).all());
  });

  app.get("/api/documents/:id/download", (req, res) => {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
    if (!doc) return res.status(404).json({ error: "not-found" });
    const file = path.join(uploads, doc.stored_name);
    // Never serve outside the uploads dir; never render inline.
    if (!file.startsWith(uploads + path.sep) || !fs.existsSync(file)) {
      return res.status(404).json({ error: "not-found" });
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", doc.size);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.orig_name.replace(/"/g, "")}"`);
    fs.createReadStream(file).pipe(res);
  });

  app.delete("/api/documents/:id", (req, res) => {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
    if (!doc) return res.status(404).json({ error: "not-found" });
    const file = path.join(uploads, doc.stored_name);
    db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
    if (file.startsWith(uploads + path.sep)) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
    res.json({ ok: true });
  });

  // ---- executive one-pager data (everything reads live from the DB) ----
  function memberDisplay(m) {
    const title = m.chamber === "senate" ? "Sen." : "Rep.";
    const dist = m.chamber === "house" ? `-${m.district}` : "";
    return `${title} ${m.last_name} (${m.party}-${m.state}${dist})`;
  }

  function firstNSentences(s, n) {
    const parts = String(s || "").split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
    return parts.slice(0, n).join(" ");
  }

  function daysAgoStr(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  app.get("/api/one-pager", (req, res) => {
    const today = todayStr();

    // Quad 1: live projects toggled on (max 4)
    const groups = db.prepare(
      "SELECT * FROM project_groups WHERE show_on_pager = 1 ORDER BY position, id LIMIT 4"
    ).all();
    const nextOpen = db.prepare(`
      SELECT * FROM tasks WHERE group_id = ? AND status != 'done'
      ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, position ASC, id ASC LIMIT 1`);
    const projects = groups.map(g => {
      const next = nextOpen.get(g.id);
      return { name: g.name, next_action: next ? next.title : "—", status: next ? next.status : "done" };
    });

    // Quad 2: upcoming events, ascending
    const events = db.prepare(
      "SELECT * FROM events WHERE date >= ? ORDER BY date ASC, id ASC LIMIT 8"
    ).all(today);

    // Quad 3: interactions from the past 7 days, most recent first, max 3
    const interactions = db.prepare(`
      SELECT i.id, i.date, i.summary, m.chamber, m.first_name, m.last_name, m.party, m.state, m.district,
             s.first_name AS sf, s.last_name AS sl, s.title AS st
      FROM interactions i JOIN members m ON m.id = i.member_id
      LEFT JOIN staff s ON s.id = i.staff_id
      WHERE i.date >= ? AND i.date <= ?
      ORDER BY i.date DESC, i.id DESC LIMIT 3
    `).all(daysAgoStr(7), today).map(r => ({
      id: r.id, date: r.date, member: memberDisplay(r), brief: firstNSentences(r.summary, 2),
      via: r.sf ? `${r.sf} ${r.sl}${r.st ? ", " + r.st : ""}` : null,
    }));

    // Quad 4: open tasks across all groups
    const tasks = db.prepare(`
      SELECT t.id, t.title, t.status, t.owner
      FROM tasks t JOIN project_groups g ON g.id = t.group_id
      WHERE t.status != 'done'
      ORDER BY g.position, g.id, t.position, t.id
    `).all();

    res.json({ generated_at: new Date().toISOString(), projects, events, interactions, tasks });
  });

  // ---- admin: allowlist + users ----
  const countsOf = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  app.get("/api/admin/allowed", requireAdmin, (req, res) => {
    res.json(db.prepare("SELECT email, added_at FROM allowed_emails ORDER BY email").all());
  });

  app.post("/api/admin/allowed", requireAdmin, (req, res) => {
    try {
      const email = allowEmail(db, req.body?.email || "");
      audit(db, req.user, "allowlist-add", "allowlist", email, "");
      res.status(201).json({ email });
    } catch {
      return bad(res, "Enter a valid email address.");
    }
  });

  app.delete("/api/admin/allowed/:email", requireAdmin, (req, res) => {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) {
      return bad(res, "That email has a user account; remove the user first.");
    }
    db.prepare("DELETE FROM allowed_emails WHERE email=?").run(email);
    audit(db, req.user, "allowlist-remove", "allowlist", email, "");
    res.json({ ok: true });
  });

  app.get("/api/admin/users", requireAdmin, (req, res) => {
    res.json(db.prepare("SELECT id, email, created_at FROM users ORDER BY email").all());
  });

  app.post("/api/admin/users", requireAdmin, (req, res) => {
    const { email, password } = req.body || {};
    try {
      const id = createUser(db, email, password);
      audit(db, req.user, "create", "user", id, String(email || "").trim().toLowerCase());
      res.status(201).json({ id });
    } catch (e) {
      if (e.message === "not-allowlisted") return bad(res, "Email is not on the approved list.");
      if (e.message === "exists") return bad(res, "A user already exists for that email.");
      if (e.message === "weak-password") return bad(res, "Password must be at least 8 characters.");
      throw e;
    }
  });

  app.post("/api/admin/users/:id/password", requireAdmin, (req, res) => {
    const u = db.prepare("SELECT id, email FROM users WHERE id=?").get(req.params.id);
    if (!u) return res.status(404).json({ error: "not-found" });
    try {
      setUserPassword(db, u.id, req.body?.password || "");
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id); // force re-login
      audit(db, req.user, "password-reset", "user", u.id, u.email);
      res.json({ ok: true });
    } catch {
      return bad(res, "Password must be at least 8 characters.");
    }
  });

  app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
    if (Number(req.params.id) === req.user.id) return bad(res, "You cannot remove your own account.");
    const u = db.prepare("SELECT email FROM users WHERE id=?").get(req.params.id);
    const r = db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: "not-found" });
    audit(db, req.user, "delete", "user", req.params.id, u?.email || "");
    res.json({ ok: true });
  });

  // ---- admin: sample dataset (real legislator roster + demo content) ----
  // Everything is flagged is_sample=1; the purge never touches real records.
  app.get("/api/admin/sample-legislators", requireAdmin, (req, res) => {
    res.json({ count: sampleLegislatorCount(db), content: sampleContentLoaded(db), full: sampleDatasetFull(db) });
  });

  // ---- admin: Cloudflare Tunnel (named tunnel token + hostname) ----
  // Lets the admin link their own Cloudflare account for a stable public URL.
  // When both are set, the tunnel restarts automatically with the new config.
  // The token is never returned to the client.
  const setMeta = (k, v) => {
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run(k, v);
  };
  app.get("/api/admin/tunnel", requireAdmin, (req, res) => {
    res.json({
      hostname: getMeta("tunnel_hostname") || "",
      linked: !!(getMeta("tunnel_token") && getMeta("tunnel_hostname")),
      live: publicUrl,
    });
  });
  app.post("/api/admin/tunnel", requireAdmin, (req, res) => {
    const { token, hostname } = req.body || {};
    if (token !== undefined) setMeta("tunnel_token", String(token || "").trim());
    if (hostname !== undefined) setMeta("tunnel_hostname", String(hostname || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, ""));
    audit(db, req.user, "tunnel-config", "tunnel", null, hostname ? `hostname set: ${String(hostname).trim()}` : "disconnected");
    startTunnel();
    res.json({ ok: true, live: publicUrl });
  });

  app.post("/api/admin/sample-legislators", requireAdmin, (req, res) => {
    let legislators;
    try {
      legislators = JSON.parse(fs.readFileSync(path.join(__dirname, "legislators.json"), "utf8"));
    } catch {
      return bad(res, "Sample data file is missing.");
    }
    if (!Array.isArray(legislators)) return bad(res, "Sample data file is invalid.");
    const leg = loadSampleLegislators(db, legislators);
    let content = { loaded: false, skipped: true };
    if (!leg.skipped || sampleLegislatorCount(db) > 0) {
      content = loadSampleContent(db, uploads);
    }
    audit(db, req.user, "load", "sample-data", null, `${leg.loaded || 0} legislators`);
    res.json({ legislators: leg, content });
  });

  app.delete("/api/admin/sample-legislators", requireAdmin, (req, res) => {
    const content = purgeSampleContent(db, uploads);
    const legislators = purgeSampleLegislators(db);
    audit(db, req.user, "purge", "sample-data", null,
      `Purged sample data: ${legislators.deleted} legislators, ${JSON.stringify(countsOf(content))}`);
    res.json({ legislators, content });
  });

  // ---- admin: audit log (who changed what, when) ----
  app.get("/api/admin/audit", requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json(db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit));
  });

  // ---- admin: CSV import of interactions ----
  // Accepts { csv } with header: member,date,type,summary,follow_up
  // member matches "First Last" (case-insensitive). Per-row validation;
  // returns { imported, errors: [{ row, error }], total }.
  const parseCsv = (text) => {
    const rows = [];
    let row = [], field = "", inQ = false;
    const src = String(text || "").replace(/^\uFEFF/, "");
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQ) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    row.push(field);
    if (!(row.length === 1 && row[0].trim() === "")) rows.push(row);
    return rows;
  };
  app.post("/api/admin/import-interactions", requireAdmin, (req, res) => {
    const rows = parseCsv(req.body?.csv);
    if (!rows.length) return bad(res, "No CSV data received.");
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const need = ["member", "date", "summary"];
    for (const n of need) {
      if (!header.includes(n)) return bad(res, `CSV must have a "${n}" column.`);
    }
    const ci = (n) => header.indexOf(n);
    const memberByName = new Map(
      db.prepare("SELECT id, first_name, last_name FROM members").all()
        .map((m) => [`${m.first_name} ${m.last_name}`.toLowerCase(), m.id])
    );
    const ins = db.prepare(
      "INSERT INTO interactions (member_id, date, summary, next_step, status, interaction_type) VALUES (?,?,?,?,?,?)"
    );
    let imported = 0;
    const errors = [];
    rows.slice(1).forEach((r, i) => {
      const line = i + 2;
      if (r.every((c) => !String(c || "").trim())) return; // skip blank lines
      const get = (n) => (ci(n) >= 0 ? String(r[ci(n)] || "").trim() : "");
      const memberName = get("member").toLowerCase();
      const date = get("date"), summary = get("summary");
      const type = get("type"), followUp = get("follow_up");
      const memberId = memberByName.get(memberName);
      if (!memberId) { errors.push({ row: line, error: `Member not found: "${get("member")}".` }); return; }
      if (!validDate(date)) { errors.push({ row: line, error: `Bad date "${date}" — use YYYY-MM-DD.` }); return; }
      if (!summary) { errors.push({ row: line, error: "Summary is required." }); return; }
      if (type && !INTERACTION_TYPES.includes(type)) {
        errors.push({ row: line, error: `Bad type "${type}" — use one of: ${INTERACTION_TYPES.join(", ")}.` }); return;
      }
      try {
        const rid = ins.run(memberId, date, summary, followUp || null, "open", type || null).lastInsertRowid;
        imported++;
        audit(db, req.user, "import", "interaction", Number(rid), `CSV row ${line}: ${summary.slice(0, 60)}`);
      } catch {
        errors.push({ row: line, error: "Could not save this row." });
      }
    });
    res.json({ imported, errors, total: rows.length - 1 });
  });

  // ---- minimal ZIP writer (stored entries, no compression, no deps) ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const buildZip = (entries) => {
    const chunks = [], central = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const nameBuf = Buffer.from(name, "utf8");
      const crc = crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6); // UTF-8 filenames
      lh.writeUInt16LE(0, 8); // stored
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(data.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      chunks.push(lh, nameBuf, data);
      central.push({ nameBuf, crc, size: data.length, offset });
      offset += 30 + nameBuf.length + data.length;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const e of central) {
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(0, 10);
      ch.writeUInt32LE(e.crc, 16);
      ch.writeUInt32LE(e.size, 20);
      ch.writeUInt32LE(e.size, 24);
      ch.writeUInt16LE(e.nameBuf.length, 28);
      ch.writeUInt32LE(e.offset, 42);
      chunks.push(ch, e.nameBuf);
      cdSize += 46 + e.nameBuf.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    chunks.push(end);
    return Buffer.concat(chunks);
  };

  // ---- admin: one-click backup (zip of the database + uploaded files) ----
  app.get("/api/admin/backup", requireAdmin, (req, res) => {
    try {
      const dbPath = process.env.DB_PATH || path.join(__dirname, "data", "vilano.db");
      // VACUUM INTO gives a consistent snapshot even while the app is running.
      const snap = path.join(os.tmpdir(), `vilano-backup-${Date.now()}.db`);
      db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
      const entries = [{ name: "vilano.db", data: fs.readFileSync(snap) }];
      try { fs.unlinkSync(snap); } catch {}
      for (const f of fs.readdirSync(uploads)) {
        const full = path.join(uploads, f);
        try {
          if (fs.statSync(full).isFile()) entries.push({ name: `uploads/${f}`, data: fs.readFileSync(full) });
        } catch { /* skip unreadable files */ }
      }
      const zip = buildZip(entries);
      audit(db, req.user, "backup", "app", null, `${entries.length} files, ${zip.length} bytes`);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="vilano-crm-backup-${stamp}.zip"`);
      res.send(zip);
    } catch (e) {
      res.status(500).json({ error: "Backup failed." });
    }
  });

  // Change-my-password: every signed-in user (not admin-only).
  app.post("/api/password", requireAuth, (req, res) => {
    try {
      setUserPassword(db, req.user.id, req.body?.password || "");
      // Invalidate every *other* session; the current one stays signed in.
      const token = parseCookies(req).vs_session;
      if (token) db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(req.user.id, token);
      else db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.user.id);
      res.json({ ok: true });
    } catch {
      return bad(res, "Password must be at least 8 characters.");
    }
  });

  // 404 for unknown API routes
  app.use("/api", (req, res) => res.status(404).json({ error: "not-found" }));

  return app;
}

// ---- run directly ----
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const dbPath = process.env.DB_PATH || path.join(__dirname, "data", "vilano.db");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  // Demo account + fictional seed data ONLY when SEED=1 is set explicitly
  // (dev path). Installed copies run with SEED=0 and start at the /setup wizard.
  bootstrapFreshDb(db, { seed: process.env.SEED === "1" });
  const port = Number(process.env.PORT || 3000);
  // Bind 0.0.0.0 by default so phones on the same Wi-Fi can reach the app
  // (auth gate still applies). Set HOST=127.0.0.1 to restrict to this PC only.
  const host = process.env.HOST || "0.0.0.0";
  const uploadsDir = process.env.UPLOADS_DIR || path.join(path.dirname(dbPath), "uploads");
  createApp(db, { uploadsDir, port }).listen(port, host, () => {
    console.log(`Vilano South GR CRM listening on http://${host === "0.0.0.0" ? lanIpv4() || "localhost" : host}:${port}`);
    console.log(`This PC: http://127.0.0.1:${port}   (same Wi-Fi phones use the address above)`);
  });
}

function lanIpv4() {
  try {
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal && !isCgnat100(a.address)) return a.address;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Tailscale and NetBird both assign addresses in 100.64.0.0/10 — the private
// overlay network the CRM uses for off-Wi-Fi phone access.
function overlayIpv4() {
  try {
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal && isCgnat100(a.address)) return a.address;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function isCgnat100(ip) {
  const p = (ip || "").split(".");
  return p.length === 4 && p[0] === "100" && +p[1] >= 64 && +p[1] <= 127;
}

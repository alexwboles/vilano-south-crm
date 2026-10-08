#!/usr/bin/env bash
# Build VilanoCRM-Setup.exe on Linux: portable Node + cross-compiled tray +
# NSIS installer. Re-runnable; outputs the Setup.exe to the dist folder.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSDIR="$ROOT/installer"
STAGING="$INSDIR/staging"
CACHE="$INSDIR/cache"
DIST="$HOME/workspace/your_files/vilano-crm-dist"
OUT="$DIST/VilanoCRM-Setup.exe"
NODE_PIN="v22.21.1"   # fallback if the version lookup fails

export PATH="$PATH:/usr/local/go/bin"

echo "== Vilano CRM installer build =="

# ---- 1. portable Node win-x64 (bundled: no download at install time) ----
mkdir -p "$CACHE"
NODE_VER="$(curl -sL --max-time 30 https://nodejs.org/dist/index.json \
  | python3 -c 'import json,sys
vs=[v["version"] for v in json.load(sys.stdin) if v["version"].startswith("v22.") and v.get("lts")]
print(vs[0] if vs else "")' 2>/dev/null || true)"
if [ -z "${NODE_VER:-}" ]; then NODE_VER="$NODE_PIN"; echo "version lookup failed, pinned to $NODE_VER"; fi
echo "node: $NODE_VER"
ZIP="$CACHE/node-$NODE_VER-win-x64.zip"
if [ ! -f "$ZIP" ]; then
  curl -sL --fail -o "$ZIP" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip"
fi

# ---- 2. tray exe (Go cross-compile, GUI subsystem: no console flash) ----
# Skips the rebuild when the binary is newer than the source (Go may not be
# installed on every build machine).
echo "building tray..."
if [ "$ROOT/tray/VilanoTray.exe" -nt "$ROOT/tray/main.go" ] 2>/dev/null; then
  echo "tray: reusing existing VilanoTray.exe (source unchanged)"
else
  (cd "$ROOT/tray" && GOOS=windows GOARCH=amd64 go build -ldflags="-H windowsgui" -o VilanoTray.exe .)
fi
file "$ROOT/tray/VilanoTray.exe" | grep -q "PE32+" || { echo "tray build did not produce a PE"; exit 1; }

# ---- 3. node_modules (pure-JS deps; safe to build on Linux for Windows) ----
echo "installing node modules..."
(cd "$ROOT" && npm ci --no-audit --no-fund 2>&1 | tail -1)

# ---- 4. stage payload (data/ deliberately excluded: upgrades never touch it) ----
echo "staging..."
rm -rf "$STAGING"
mkdir -p "$STAGING/nodejs" "$STAGING/public" "$STAGING/node_modules"
cp "$ROOT/tray/VilanoTray.exe" "$STAGING/"
cp "$ROOT/server.js" "$ROOT/db.js" "$ROOT/sample-content.js" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/README.md" "$ROOT/legislators.json" "$STAGING/"
cp -r "$ROOT/public/." "$STAGING/public/"
cp -r "$ROOT/node_modules/." "$STAGING/node_modules/"
# ---- 4b. NetBird client (optional phone-access dependency) ----
# Downloaded at build time from the official GitHub releases; the NSIS
# installer offers it as an opt-out section and runs it silently (/S).
# Best-effort: if the download fails the build continues and the installer
# simply skips the NetBird step (the phone guide covers manual install).
echo "netbird..."
STAGING="$STAGING" python3 - <<'EOF' || echo "WARNING: NetBird download failed; continuing without it"
import os, urllib.request, json
stg = os.environ["STAGING"]
req = urllib.request.Request(
    "https://api.github.com/repos/netbirdio/netbird/releases/latest",
    headers={"User-Agent": "vilano-crm-build", "Accept": "application/vnd.github+json"})
rel = json.load(urllib.request.urlopen(req, timeout=30))
cands = [a["browser_download_url"] for a in rel["assets"]
         if a["name"].lower().endswith(".exe") and "windows" in a["name"].lower()
         and "amd64" in a["name"].lower() and "installer" in a["name"].lower()]
if not cands:
    raise SystemExit("no windows installer asset found")
url = cands[0]
print("downloading", url)
dest = os.path.join(stg, "netbird-installer.exe")
urllib.request.urlretrieve(url, dest)
if os.path.getsize(dest) < 1024 * 1024:
    os.remove(dest)
    raise SystemExit("download too small, likely an error page")
print("netbird staged: %.1f MB" % (os.path.getsize(dest) / 1024 / 1024))
EOF
# ---- 4c. Tailscale client (opt-in phone-access alternative) ----
# Downloaded at build time from the official package server; the NSIS
# installer offers it as an opt-IN section (NetBird is the default).
# Best-effort: if the download fails the build continues.
echo "tailscale..."
STAGING="$STAGING" python3 - <<'EOF' || echo "WARNING: Tailscale download failed; continuing without it"
import os, re, urllib.request
stg = os.environ["STAGING"]
html = urllib.request.urlopen(
    urllib.request.Request("https://pkgs.tailscale.com/stable/",
                           headers={"User-Agent": "vilano-crm-build"}),
    timeout=30).read().decode()
msis = sorted(set(re.findall(r'tailscale-setup-([0-9.]+)-amd64\.msi', html)))
if not msis:
    raise SystemExit("no tailscale msi found")
ver = msis[-1]
url = f"https://pkgs.tailscale.com/stable/tailscale-setup-{ver}-amd64.msi"
print("downloading", url)
dest = os.path.join(stg, "tailscale-setup.msi")
urllib.request.urlretrieve(url, dest)
if os.path.getsize(dest) < 1024 * 1024:
    os.remove(dest)
    raise SystemExit("download too small, likely an error page")
print("tailscale staged: %.1f MB" % (os.path.getsize(dest) / 1024 / 1024))
EOF
# ---- 4d. cloudflared (free public https link, no monthly cost) ----
# Downloaded at build time from the official GitHub releases; the NSIS
# installer offers it as an opt-out section. The CRM launches it on startup
# to publish a free https URL for phones (no VPN app needed, no user limit).
# Best-effort: if the download fails the build continues.
echo "cloudflared..."
STAGING="$STAGING" python3 - <<'EOF' || echo "WARNING: cloudflared download failed; continuing without it"
import os, urllib.request, json
stg = os.environ["STAGING"]
req = urllib.request.Request(
    "https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
    headers={"User-Agent": "vilano-crm-build", "Accept": "application/vnd.github+json"})
rel = json.load(urllib.request.urlopen(req, timeout=30))
cands = [a["browser_download_url"] for a in rel["assets"]
         if a["name"] == "cloudflared-windows-amd64.exe"]
if not cands:
    raise SystemExit("no cloudflared windows exe found")
url = cands[0]
print("downloading", url)
dest = os.path.join(stg, "cloudflared.exe")
urllib.request.urlretrieve(url, dest)
if os.path.getsize(dest) < 1024 * 1024:
    os.remove(dest)
    raise SystemExit("download too small, likely an error page")
print("cloudflared staged: %.1f MB" % (os.path.getsize(dest) / 1024 / 1024))
EOF
python3 - "$ZIP" "$STAGING/nodejs" <<'EOF'
import sys, zipfile
z, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(z) as zf:
    for n in zf.namelist():
        if n.endswith("/node.exe") and n.count("/") == 1:
            with zf.open(n) as src, open(f"{dest}/node.exe", "wb") as out:
                out.write(src.read())
            print("extracted node.exe")
            break
EOF
[ -f "$STAGING/nodejs/node.exe" ] || { echo "node.exe missing from staging"; exit 1; }
[ -f "$STAGING/public/favicon.ico" ] || { echo "favicon missing from staging"; exit 1; }
echo "staged files: $(find "$STAGING" -type f | wc -l)"

# ---- 5. compile the installer ----
command -v makensis >/dev/null || { echo "makensis not found — install nsis"; exit 1; }
mkdir -p "$DIST"
echo "compiling installer..."
(cd "$INSDIR" && makensis -DOUTFILE="$OUT" installer.nsi)
ls -la "$OUT"
echo "done: $OUT"

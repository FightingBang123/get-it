/**
 * Get It. updater.
 *
 * Checks GitHub releases for a newer tag than the installed app's
 * version. If found, shows a polished BrowserWindow with release
 * notes + Update / Later. On "Update", downloads the right asset
 * for this platform with a live progress bar, opens the installer
 * via the OS, and quits the running app so the installer can take
 * over.
 *
 * Cross-platform asset matching:
 *   macOS arm64 → *-arm64.dmg
 *   macOS x64   → *.dmg (without "arm64")
 *   Windows x64 → *.exe (NSIS)
 *   Linux x64   → *.AppImage
 *
 * Robustness:
 *   • "Later" is remembered per release (userData/update-state.json),
 *     so the modal appears once per version instead of on every launch.
 *   • A build reporting version 0.0.0 was never stamped with a release
 *     version; the check is skipped rather than treating every release
 *     as newer.
 *   • Network failure → silently skip the check (the user sees the
 *     wizard / app as if no update existed).
 *   • Missing matching asset → skip too (a release that doesn't
 *     ship our platform isn't actionable).
 *   • Download interrupted → re-throw to the renderer, which
 *     surfaces the error and re-enables the buttons.
 */

"use strict";

const { BrowserWindow, app, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");

const GITHUB_OWNER = "beltromatti";
const GITHUB_REPO = "get-it";
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// ── HTTP helper with redirect following ─────────────────────────────────
function httpsGet(url, headers = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: { "User-Agent": "get-it-updater", ...headers },
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume();
            httpsGet(res.headers.location, headers, redirectsLeft - 1).then(
              resolve,
              reject,
            );
            return;
          }
          resolve(res);
        },
      )
      .on("error", reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { Accept: "application/vnd.github+json" })
      .then((res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      })
      .catch(reject);
  });
}

// ── Semver-ish compare ─────────────────────────────────────────────────
function compareVersions(a, b) {
  const norm = (s) =>
    String(s ?? "0.0.0")
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// ── Asset matching ─────────────────────────────────────────────────────
function pickAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const { platform, arch } = process;
  if (platform === "darwin") {
    if (arch === "arm64") {
      return (
        assets.find((a) => /-arm64\.dmg$/i.test(a.name)) ||
        assets.find((a) => /\.dmg$/i.test(a.name) && /arm64/i.test(a.name)) ||
        null
      );
    }
    return (
      assets.find((a) => /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name)) ||
      null
    );
  }
  if (platform === "win32") {
    return (
      assets.find((a) => /\.exe$/i.test(a.name)) ||
      assets.find((a) => /\.msi$/i.test(a.name)) ||
      null
    );
  }
  if (platform === "linux") {
    return assets.find((a) => /\.AppImage$/i.test(a.name)) || null;
  }
  return null;
}

// ── Window + state ─────────────────────────────────────────────────────
let updateWindow = null;
let pending = null;

// A version the user already said "Later" to. Persisted so the prompt
// fires once per release instead of on every launch; a strictly newer
// release still prompts.
function updateStateFile() {
  return path.join(app.getPath("userData"), "update-state.json");
}

function readUpdateState() {
  try {
    const raw = fs.readFileSync(updateStateFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeUpdateState(next) {
  try {
    const file = updateStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch {
    // Losing the skip marker only means one extra prompt; never fail boot.
  }
}

async function checkOnceForUpdate() {
  try {
    const data = await fetchJson(RELEASES_LATEST_URL);
    if (!data || typeof data.tag_name !== "string") return null;
    const latestVersion = data.tag_name.replace(/^v/, "");
    const currentVersion = app.getVersion();
    if (compareVersions(latestVersion, currentVersion) <= 0) return null;
    const asset = pickAsset(data.assets);
    if (!asset) return null;
    return {
      latestVersion,
      currentVersion,
      releaseUrl: data.html_url,
      releaseBody: data.body || "",
      asset: {
        name: asset.name,
        size: asset.size,
        downloadUrl: asset.browser_download_url,
      },
    };
  } catch {
    return null;
  }
}

function downloadAsset(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    httpsGet(url)
      .then((res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} downloading update`));
          return;
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        const f = fs.createWriteStream(dest);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0) onProgress?.({ pct: (received / total) * 100, received, total });
        });
        res.pipe(f);
        f.once("finish", () => f.close(() => resolve()));
        f.once("error", reject);
        res.once("error", reject);
      })
      .catch(reject);
  });
}

function ensureIpc() {
  if (ensureIpc._wired) return;
  ensureIpc._wired = true;

  ipcMain.handle("update:status", () => pending);

  ipcMain.handle("update:dismiss", (_e, didUpdate) => {
    closeUpdateWindow(didUpdate === true);
  });

  ipcMain.handle("update:install", async () => {
    if (!pending) throw new Error("No update pending");
    // Count this as an in-app self-update so the dashboard can separate
    // updates from genuine first-time downloads. Fire-and-forget; never let
    // it affect the update itself.
    try {
      require("./analytics").trackUpdate(
        pending.currentVersion,
        pending.latestVersion,
      );
    } catch {
      /* ignore */
    }
    const url = pending.asset.downloadUrl;
    const filename = pending.asset.name;
    const downloads = app.getPath("downloads") || os.tmpdir();
    const dest = path.join(downloads, filename);

    const sendProgress = (p) => {
      if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.webContents.send("update-progress", p);
      }
    };

    sendProgress({ label: "Downloading…", pct: 0 });
    try {
      await downloadAsset(url, dest, ({ pct }) =>
        sendProgress({ label: "Downloading…", pct }),
      );
    } catch (e) {
      throw new Error(`Download failed: ${e instanceof Error ? e.message : e}`);
    }

    sendProgress({ label: "Opening installer…", pct: 100 });

    // Hand the installer to the OS. On macOS this mounts the .dmg in
    // Finder; on Windows it launches the NSIS installer; on Linux it
    // surfaces the AppImage to the user's default file manager.
    const openErr = await shell.openPath(dest);
    if (openErr) {
      throw new Error(`Could not open installer: ${openErr}`);
    }

    // Quit ourselves so the installer can replace files on disk.
    // On macOS the user finishes the drag-to-Applications step
    // after we exit. On Windows NSIS prompts to overwrite.
    setTimeout(() => {
      closeUpdateWindow(true);
      app.quit();
    }, 800);
  });
}

function closeUpdateWindow(didUpdate) {
  const w = updateWindow;
  updateWindow = null;
  if (w && !w.isDestroyed()) w.close();
  if (closeUpdateWindow._resolve) {
    const r = closeUpdateWindow._resolve;
    closeUpdateWindow._resolve = null;
    r(!!didUpdate);
  }
}

function showUpdateWindow() {
  return new Promise((resolve) => {
    closeUpdateWindow._resolve = resolve;
    updateWindow = new BrowserWindow({
      width: 560,
      height: 540,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Get It. — Update available",
      backgroundColor: "#ffffff",
      webPreferences: {
        preload: path.join(__dirname, "preload-update.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    updateWindow.removeMenu?.();
    updateWindow.loadFile(path.join(__dirname, "update-window", "index.html"));
    updateWindow.on("closed", () => {
      const r = closeUpdateWindow._resolve;
      closeUpdateWindow._resolve = null;
      updateWindow = null;
      if (r) r(false);
    });
  });
}

// ── Public API ──────────────────────────────────────────────────────────

function isCheckEnabled() {
  // Explicit opt-out (testing / corporate networks).
  if (process.env.GETIT_SKIP_UPDATE === "1") return false;
  // A build that never had a version stamped (a working checkout builds
  // with package.json#version still at 0.0.0) has nothing meaningful to
  // compare against: every published release looks newer, so the prompt
  // would fire on every launch for a build the user cannot upgrade from
  // this dialog anyway.
  return app.getVersion() !== "0.0.0";
}

/**
 * Starts the GitHub check without showing anything, so the caller can
 * overlap the network round-trip with slower boot work (the embedded
 * server takes seconds). Resolves to null when the check is disabled or
 * no actionable release exists. Pass the promise to maybeRunUpdate().
 */
function prefetchUpdate() {
  if (!isCheckEnabled()) return Promise.resolve(null);
  return checkOnceForUpdate();
}

/**
 * Shows the update prompt for an already-running (or fresh) check.
 *
 * Returns true if the user kicked off an update (app is quitting), false
 * if they declined or there was no update. The caller MUST short-circuit
 * the rest of startup when this returns true.
 */
async function maybeRunUpdate(prefetched) {
  if (!isCheckEnabled()) return false;

  ensureIpc();
  pending = await (prefetched || checkOnceForUpdate());
  if (!pending) return false;

  const latestVersion = pending.latestVersion;
  const state = readUpdateState();
  if (
    state.skippedVersion &&
    compareVersions(latestVersion, state.skippedVersion) <= 0
  ) {
    pending = null;
    return false;
  }

  try {
    const didUpdate = await showUpdateWindow();
    if (!didUpdate) {
      writeUpdateState({
        ...state,
        skippedVersion: latestVersion,
        skippedAt: new Date().toISOString(),
      });
    }
    return didUpdate;
  } catch {
    return false;
  } finally {
    pending = null;
  }
}

module.exports = { maybeRunUpdate, prefetchUpdate };

// Silence unused-var linting for dialog import (kept available in case
// we want to surface a download-failed native alert in the future).
void dialog;

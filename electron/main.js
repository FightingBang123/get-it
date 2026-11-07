/**
 * Get It. — Electron main process.
 *
 * Responsibilities:
 *  1. Resolve the per-user data directory (Electron's userData) and expose
 *     it to the Next.js child via the GETIT_DATA_DIR env var. The Next
 *     server reads that env var to anchor every on-disk path — same
 *     resolution rules as in pure-Next dev, so the layout is identical
 *     whether you run `npm run dev` or open the packaged app.
 *
 *  2. Run the Codex setup wizard (electron/setup.js) before launching the
 *     main window: detect the Codex CLI binary, prompt to install it if
 *     missing, prompt for `codex login` if the user is not authenticated,
 *     and re-enter this wizard mid-session if Codex ever stops working.
 *
 *  3. Spawn `.next/standalone/server.js` as a child Node process on a
 *     free localhost port, wait for it to respond, then open a
 *     BrowserWindow pointing at that URL. The UI is the exact same Next.js
 *     app you see in the browser — no DOM rewiring.
 *
 *  4. Forward graceful shutdown to the child so we never leave a zombie
 *     server on a port (a real problem on Windows that breaks the next
 *     launch).
 */

"use strict";

// Guard: if ELECTRON_RUN_AS_NODE leaks into the env, Electron loads as
// plain Node and `app` is undefined — manifesting as a confusing
// "Cannot read properties of undefined (reading 'requestSingleInstanceLock')"
// crash. Detect and bail out cleanly with a useful message.
if (process.env.ELECTRON_RUN_AS_NODE === "1") {
  // eslint-disable-next-line no-console
  console.error(
    "[get-it] ELECTRON_RUN_AS_NODE=1 is set — unsetting it so Electron starts in main-process mode.\n" +
      "  If you're seeing this in a real packaged install, please report it.",
  );
  delete process.env.ELECTRON_RUN_AS_NODE;
}

const electronModule = require("electron");
if (typeof electronModule === "string") {
  // We were loaded as a node script, not as the Electron entry point.
  // This is almost always the same env-var problem above; just exit
  // before the API-undefined crash.
  // eslint-disable-next-line no-console
  console.error(
    "[get-it] The Electron API is not available. Did you launch with `npx electron .`?",
  );
  process.exit(1);
}

const { app, BrowserWindow, dialog, shell, ipcMain, nativeTheme } = electronModule;

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const {
  ensureCodexReady,
  ensureProviderReady,
  showSetupWindow,
  resolveCodexBinary,
  refreshCodexStatus,
  onCodexStatusChange,
} = require("./setup");
const { maybeRunUpdate, prefetchUpdate } = require("./updater");
const analytics = require("./analytics");

// ── Single-instance lock ────────────────────────────────────────────────
// If the user double-clicks the app icon a second time, focus the existing
// window rather than spawning a second Next server (port conflict + KG
// races on the same data dir).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

// ── Data dir resolution ─────────────────────────────────────────────────
// `app.getPath('userData')` defaults to:
//   macOS:  ~/Library/Application Support/<productName>
//   Windows: %APPDATA%/<productName>
//   Linux:  ~/.config/<productName>
// We set productName explicitly so this matches the AGENTS dir used in
// pure-Next dev (lib/paths.ts → defaultUserDataDir).
// We want the on-disk folder to be `get-it` (no space) so it matches the
// pure-Next dev default (lib/paths.ts → defaultUserDataDir). Electron's
// default would be `Application Support/Get It` because productName has
// a space; force the override here BEFORE anyone calls app.getPath().
app.setName("get-it");
const ELECTRON_USER_DATA_PARENT = path.dirname(app.getPath("userData"));
const DATA_DIR = path.join(ELECTRON_USER_DATA_PARENT, "get-it");
app.setPath("userData", DATA_DIR);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "logs"), { recursive: true });

// ── Resolve the Next.js standalone server entry ─────────────────────────
// In `electron .` dev mode the user runs `npm run dev:hmr` which
// boots `next dev` separately and points us at it via the env var.
// In production the standalone server lives next to this file inside the
// app's resources directory.
const DEV_URL = process.env.ELECTRON_DEV_URL || null;

function resolveStandalonePath() {
  // In packaged mode `app.getAppPath()` resolves to the asar archive
  // (e.g. .../resources/app.asar). Electron's patched `fs` reads through
  // asar transparently so `fs.existsSync` finds server.js inside it — but
  // `child_process.spawn` uses native libuv which has no asar awareness,
  // so passing an asar path as `cwd` makes CreateProcessW (Windows) /
  // posix_spawn (mac) fail and Node surfaces it as `spawn <exe> ENOENT`
  // (the exe is just what libuv puts in the error string; the real cause
  // is the cwd not existing on disk). Always prefer the real on-disk
  // unpacked directory in packaged mode — `.next/standalone/**` is in
  // `asarUnpack` so it's there.
  const candidates = [];
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "app.asar.unpacked", ".next", "standalone"),
    );
  }
  // Dev / source-tree run: project root.
  candidates.push(path.join(app.getAppPath(), ".next", "standalone"));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "server.js"))) return c;
  }
  return null;
}

// ── Pick a free localhost port ──────────────────────────────────────────
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ── Wait until the server answers HTTP /200 ─────────────────────────────
function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http
        .get(url, { timeout: 1500 }, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) {
            resolve();
          } else {
            retry();
          }
        })
        .on("error", retry)
        .on("timeout", () => {
          req.destroy();
          retry();
        });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("Server never became ready"));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

// ── Spawn the embedded Next server ──────────────────────────────────────
let serverChild = null;
let serverUrl = null;

async function startEmbeddedServer() {
  if (DEV_URL) {
    serverUrl = DEV_URL;
    return;
  }
  const standalone = resolveStandalonePath();
  if (!standalone) {
    dialog.showErrorBox(
      "Get It. — internal error",
      "Could not find the embedded server. The packaged app is incomplete.",
    );
    app.quit();
    return;
  }
  const port = await pickFreePort();
  const env = {
    ...process.env,
    GETIT_DATA_DIR: DATA_DIR,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
  };
  // Hand the server the bundled-binary path for EVERY provider, not just the
  // one selected at boot. The server reads the active provider per-call, so if
  // the user switches providers mid-session (via the wizard) the new backend's
  // binary is already resolvable — no restart, no "binary not found".
  try {
    const codexInfo = resolveCodexBinary();
    if (codexInfo) env.CODEX_BINARY_PATH = codexInfo.path;
    const { resolveBundledBinary } = require("./setup");
    const claudePath = resolveBundledBinary("claude");
    if (claudePath) env.CLAUDE_BINARY_PATH = claudePath;
    const geminiPath = resolveBundledBinary("gemini");
    if (geminiPath) env.GEMINI_BINARY_PATH = geminiPath;
    const piPath = resolveBundledBinary("pi");
    if (piPath) env.PI_BINARY_PATH = piPath;
  } catch { /* best-effort; providers also self-resolve */ }

  const nodeBin = process.execPath; // Electron's own node — works for ES modules
  // Spawn the watchdog wrapper if it was copied next to server.js by
  // electron-prepare; fall back to plain server.js otherwise. The watchdog
  // monitors our pid and tree-kills the server if Electron dies abruptly
  // (Force Quit, kernel SIGKILL, etc.) — the dead-man's switch case.
  const watchdog = path.join(standalone, "server-watchdog.cjs");
  const serverJs = path.join(standalone, "server.js");
  const entry = fs.existsSync(watchdog) ? watchdog : serverJs;

  serverChild = spawn(nodeBin, [entry], {
    cwd: standalone,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX so we can SIGTERM the whole subtree —
    // including any `codex exec` children the SDK spawns mid-call.
    // Without this, those grandchildren get orphaned to launchd when we
    // shut down and pile up in the dock as "exec" tiles.
    detached: process.platform !== "win32",
  });

  const logPath = path.join(DATA_DIR, "logs", "server.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  serverChild.stdout?.pipe(logStream);
  serverChild.stderr?.pipe(logStream);
  serverChild.once("exit", (code, signal) => {
    logStream.write(`\n[server exited code=${code} signal=${signal} ts=${new Date().toISOString()}]\n`);
  });
  // An unhandled 'error' event on the spawn becomes an uncaught
  // exception that Electron surfaces as a generic "JavaScript error
  // in the main process" dialog — exactly the cryptic crash users hit
  // before this bug was caught. Catch the event, log it, and let
  // waitForHttp time out so the boot handler can show a real message.
  serverChild.on("error", (err) => {
    try {
      logStream.write(`\n[server spawn error ts=${new Date().toISOString()}]: ${err && err.stack ? err.stack : err}\n`);
    } catch {
      /* ignore */
    }
  });

  serverUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(serverUrl, 45000);
}

/**
 * Cross-platform kill of an entire process tree. On POSIX we send the
 * signal to the negative pid (process group) — the server child was
 * spawned `detached: true` so it owns its group, which includes any
 * `codex exec` subprocesses the SDK launches. On Windows `taskkill /T`
 * walks the tree explicitly.
 */
function killProcessTree(pid, signal = "SIGTERM") {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* ignore */
    }
  }
}

function stopEmbeddedServer() {
  if (!serverChild || serverChild.killed) return;
  const pid = serverChild.pid;
  serverChild = null;
  if (typeof pid !== "number") return;
  // Stage 1: SIGTERM the whole group — server + codex descendants get a
  // chance to finish their synchronous writeFileSync calls.
  killProcessTree(pid, "SIGTERM");
  // Stage 2: SIGKILL anything that didn't respect SIGTERM. We deliberately
  // do NOT .unref() this timer — when Electron is racing through its own
  // shutdown (e.g. on Ctrl+C through the terminal chain) an unrefed timer
  // can be skipped before it fires, leaving the server child orphaned.
  setTimeout(() => killProcessTree(pid, "SIGKILL"), 120);
}

// ── Main window ─────────────────────────────────────────────────────────
let mainWindow = null;

// Window chrome (the native open-flash background and the Windows title-bar
// overlay) is painted by the OS *before* the Next renderer mounts, so it has
// to match the user's theme up front or a light-mode user gets a dark flash
// and a permanently dark Windows caption. We read the same persisted
// `settings.json` the app does; `undefined`/absent means "follow system",
// which we resolve through Electron's nativeTheme.
function prefersDarkChrome() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf-8");
    const theme = JSON.parse(raw).theme;
    if (theme === "dark") return true;
    if (theme === "system") return nativeTheme.shouldUseDarkColors;
    // "light" or anything else → the light default
    return false;
  } catch {
    /* no saved setting yet — default to light */
    return false;
  }
}

// Editorial "ink on warm white" palette, matched to app/globals.css so the
// native chrome and the web UI agree in both themes.
const CHROME = {
  dark: { bg: "#111113", overlayBg: "#111113", overlaySymbol: "#e4e4e7" },
  light: { bg: "#ffffff", overlayBg: "#ffffff", overlaySymbol: "#111113" },
};

// ── Splash ──────────────────────────────────────────────────────────────
// Nothing is on screen until the embedded server answers AND the renderer
// has painted — several seconds on a cold start. A tiny frameless window
// closes that gap: created synchronously at whenReady, torn down as soon
// as another window is about to be shown.
let splashWindow = null;
let mainWindowPending = false;

function showSplash() {
  const chrome = prefersDarkChrome() ? CHROME.dark : CHROME.light;
  splashWindow = new BrowserWindow({
    width: 380,
    height: 220,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: chrome.bg,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  splashWindow.removeMenu?.();

  // The page carries no script (CSP default-src 'none'), so the dark
  // palette is pushed in as CSS before the first paint.
  splashWindow.webContents.once("dom-ready", () => {
    if (!prefersDarkChrome()) return;
    splashWindow?.webContents.insertCSS(
      ":root{--bg:#111113;--ink-900:#f4f4f5;--ink-500:#9a9aa6;--ink-300:#3a3a42;--accent-600:#6f8dff}",
    );
  });

  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

function closeSplash() {
  const w = splashWindow;
  splashWindow = null;
  if (w && !w.isDestroyed()) w.destroy();
}

// Any window other than the splash (setup wizard, update prompt) means the
// user now has real UI to look at, so drop the splash rather than leaving
// it behind them. The main window is exempt: it is created hidden and
// closes the splash itself once it has painted.
app.on("browser-window-created", (_event, win) => {
  if (win === splashWindow || mainWindowPending) return;
  closeSplash();
});

function createMainWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const chrome = prefersDarkChrome() ? CHROME.dark : CHROME.light;
  mainWindowPending = true;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: "Get It.",
    backgroundColor: chrome.bg,
    show: false,
    // Modern integrated title bar: the app's top tab-bar becomes the
    // drag region, and platform-native window controls are inset into
    // its leading (macOS) or trailing (Windows) edge.
    //   • macOS: "hiddenInset" hides the native title strip but keeps
    //     the traffic-light buttons floating over our chrome. We nudge
    //     them down a couple of pixels so they vertically center with
    //     the tab-bar's chips.
    //   • Windows: "hidden" + titleBarOverlay draws minimise/maximise/
    //     close as system controls inside a 36-px strip we leave clear
    //     on the right side of the tab-bar.
    //   • Linux: leave the system frame on — GTK/KDE compositors don't
    //     support titleBarOverlay yet and a custom-button fallback
    //     would feel out of place next to native windows. The tab-bar
    //     still sits at the very top, the OS just paints its own
    //     decoration above it.
    titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
    titleBarOverlay: isWin
      ? { color: chrome.overlayBg, symbolColor: chrome.overlaySymbol, height: 36 }
      : undefined,
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindowPending = false;
    closeSplash();
    mainWindow?.show();
  });

  // Force any new-window request (e.g. shell.openExternal) into the OS
  // browser. The packaged app never opens secondary windows itself.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (!serverUrl) {
    dialog.showErrorBox(
      "Get It. — internal error",
      "The embedded server did not start.",
    );
    app.quit();
    return;
  }
  mainWindow.loadURL(serverUrl);
}

// ── IPC: expose Codex status / refresh to the renderer ──────────────────
// The setup module is the source of truth for codex state. The renderer
// queries it through these IPC channels; updates push as `codex-status`
// events.
ipcMain.handle("codex:status", () => refreshCodexStatus());
ipcMain.handle("codex:setup", async () => {
  await showSetupWindow({ reason: "manual" });
  return refreshCodexStatus();
});

onCodexStatusChange((status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("codex-status", status);
  }
});

// ── Lifecycle ───────────────────────────────────────────────────────────

/**
 * Second-instance: another launch attempt while we're already running.
 * The single-instance lock at the top of this file rejected that launch;
 * here we receive a heads-up and surface the existing window. Cross-
 * platform: on macOS clicking the dock icon doesn't trigger this — that's
 * `activate` — but launching the .app a second time from Finder does.
 * On Windows / Linux double-clicking the shortcut a second time is the
 * common case.
 */
app.on("second-instance", () => {
  focusMainWindow();
});

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// ── Bootstrap guard ─────────────────────────────────────────────────────
// We open transient windows BEFORE the main window: the update modal and
// the codex setup wizard. When the user dismisses one of those (e.g. clicks
// "Later" on the update prompt), it briefly becomes the last open window,
// which would normally trip `window-all-closed` and quit the app — making
// it look like nothing happens after the modal closes. While we're still
// booting, the explicit code path (this whenReady handler) decides when to
// quit; the auto-quit on last-window-close only kicks in once the main
// window has actually opened.
let bootstrapping = true;

app.whenReady().then(async () => {
  // Paint something before the first await: everything below this line
  // used to happen on a blank screen.
  showSplash();

  try {
    // Start the GitHub release check now and let it run underneath the
    // provider check and the server boot. It used to sit serially in
    // front of both, putting a network round-trip on every cold start.
    const updateCheck = prefetchUpdate();

    // The provider check can spawn a CLI and the Next server takes
    // seconds to answer; they are independent, so overlap them. Any
    // setup wizard that opens closes the splash on creation.
    const serverReady = startEmbeddedServer();
    // Avoid an unhandled rejection when we bail out before awaiting it.
    serverReady.catch(() => {});

    const ok = await ensureProviderReady();
    if (!ok) {
      app.quit();
      return;
    }
    await serverReady;

    // Block on the update decision only now — the network call has had
    // the whole provider + server boot to complete. If the user accepts
    // the update, we quit here and the new installer takes over.
    const userKickedOffUpdate = await maybeRunUpdate(updateCheck);
    if (userKickedOffUpdate) {
      // updater.js calls app.quit() on its own; just bail out. The "update"
      // analytics event is fired from the updater itself, so we don't also
      // count this launch as an "open" — it's an update, not a session.
      return;
    }

    // Anonymous "the app launched" ping (fire-and-forget). Counts a real
    // session: only fired once we've decided NOT to update and are booting
    // the app for use. Powers Total/Daily/Weekly/Monthly users.
    analytics.trackOpen();

    createMainWindow();
    bootstrapping = false;
  } catch (err) {
    bootstrapping = false;
    closeSplash();
    dialog.showErrorBox(
      "Get It. — failed to start",
      String(err && err.message ? err.message : err),
    );
    app.quit();
  }
});

/**
 * Closing the window = quitting the app. On macOS this overrides the
 * platform convention (where the X just hides the window) because that's
 * what the user explicitly asked for: one click on the red X and Get It.
 * is fully gone.
 *
 * While bootstrapping is true the auto-quit is suppressed — the boot
 * handler above is the source of truth for whether we should stop. Once
 * the main window opens, this becomes the normal quit-on-close behaviour.
 *
 * All persistence is synchronous (work-context, KG, tags, settings use
 * fs.writeFileSync) and the renderer's debounced state flushes through
 * `fetch(..., { keepalive: true })` so any save in flight at close time
 * still lands on disk before we kill the server.
 */
app.on("window-all-closed", () => {
  if (bootstrapping) return;
  app.quit();
});

/**
 * Before-quit: give in-flight keepalive fetches a brief window to land
 * before we tear down the embedded server. 350ms is enough for a localhost
 * round-trip + synchronous writeFileSync without being noticeable to the
 * user. We use app.exit() instead of letting the event loop drain because
 * Electron occasionally hangs on its own GPU-process teardown otherwise.
 */
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return; // re-entry from our own exit() — let it through
  event.preventDefault();
  quitting = true;
  setTimeout(() => {
    stopEmbeddedServer();
    app.exit(0);
  }, 350);
});

/**
 * Native signals: when the user kills `electron .` from a terminal
 * (Ctrl+C, `kill <pid>`, etc.), Electron doesn't always fire before-quit
 * before terminating — and our server child + its codex subprocesses
 * would be reparented to launchd and pile up. Catch the signals here,
 * tree-kill the children, then exit.
 *
 * The two setTimeouts below are intentionally NOT .unref()'d. We need
 * Node's event loop to wait for them — without that, an unref'd timer
 * can be dropped when Electron tears down before the timer fires and
 * the server child gets reparented to launchd. Total shutdown time
 * after Ctrl+C is ~220 ms, all of it spent making sure the tree dies.
 */
function signalShutdown(signal) {
  if (quitting) return;
  quitting = true;
  try {
    stopEmbeddedServer();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      app.exit(signal === "SIGINT" ? 130 : 143);
    } catch {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  }, 200);
}
process.on("SIGINT", () => signalShutdown("SIGINT"));
process.on("SIGTERM", () => signalShutdown("SIGTERM"));
process.on("SIGHUP", () => signalShutdown("SIGHUP"));

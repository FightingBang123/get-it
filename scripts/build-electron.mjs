#!/usr/bin/env node
/**
 * scripts/build-electron.mjs
 *
 * One entry point for local desktop builds.
 *
 *   node scripts/build-electron.mjs --target=mac-arm64
 *   node scripts/build-electron.mjs --target=mac-x64
 *   node scripts/build-electron.mjs --target=win-x64
 *   node scripts/build-electron.mjs --target=linux-x64
 *   node scripts/build-electron.mjs --all      # sequential: mac-arm64, mac-x64, win-x64, linux-x64
 *
 * Internally each target invokes electron-builder with the right flags
 * AFTER running `npm run electron:prepare -- --target=<target-triple>` so
 * the matching Codex CLI binary is in place. Builds run sequentially —
 * artefacts land in dist-electron/.
 *
 * CI runners use this same script via the GitHub Actions matrix in
 * .github/workflows/release.yml.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppVersion } from "./app-version.cjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1] ?? null;
const all = args.includes("--all");

const TARGETS = {
  "mac-arm64": {
    builderFlag: ["--mac", "--arm64"],
    prepareTriple: "darwin-arm64",
  },
  "mac-x64": {
    builderFlag: ["--mac", "--x64"],
    prepareTriple: "darwin-x64",
  },
  "win-x64": {
    builderFlag: ["--win", "--x64"],
    prepareTriple: "win32-x64",
  },
  "linux-x64": {
    builderFlag: ["--linux", "--x64"],
    prepareTriple: "linux-x64",
  },
};

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...opts,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${cmdArgs.join(" ")} exited with code ${code}`));
    });
  });
}

/**
 * Inspects the host for the artefacts needed to produce a fully
 * Developer-ID-signed and Apple-notarized macOS DMG. Returns the
 * electron-builder CLI flags and env-var overrides for the detected
 * mode. There are three viable states:
 *
 *   1. `developer-id` — a "Developer ID Application" identity is in the
 *      keychain AND the App Store Connect API key trio is exported
 *      (APPLE_API_KEY = path to the .p8, APPLE_API_KEY_ID, APPLE_API_ISSUER)
 *      or the legacy Apple-ID password trio (APPLE_ID +
 *      APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID). Flags flip
 *      `mac.hardenedRuntime` and `mac.notarize` to true; electron-
 *      builder signs every binary with the cert, ships the bundle to
 *      Apple's notary service, and staples the ticket onto the .app
 *      inside the .dmg. Gatekeeper opens the download with no prompt.
 *
 *   2. `developer-id-no-notary` — cert is present but no notary
 *      credentials. We keep Hardened Runtime on so the build is
 *      notarizable later, but skip the notarization step. Useful for
 *      local one-off checks before the secrets are wired up; a
 *      quarantined download will still trip Gatekeeper.
 *
 *   3. `ad-hoc` — no Developer ID cert (or explicit
 *      `CSC_IDENTITY_AUTO_DISCOVERY=false` override). Falls back to
 *      the legacy free path: the electron-after-sign.cjs hook does an
 *      ad-hoc codesign pass that satisfies the Apple Silicon mandatory
 *      signature kernel check; first launch still asks the user to
 *      bypass the "unidentified developer" prompt once via System
 *      Settings → Privacy & Security → Open Anyway.
 *
 * The mode is also written into `process.env.GETIT_MAC_SIGNING_MODE`
 * so the `electron-after-sign.cjs` hook running inside electron-
 * builder can read it (the hook is invoked in the same process tree
 * as this script) and decide whether to skip the ad-hoc pass.
 */
function resolveMacSigningMode() {
  const identityProbe = spawnSync(
    "security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const identityOutput =
    (identityProbe.stdout || "") + (identityProbe.stderr || "");
  const hasDeveloperIdCert = /Developer ID Application/.test(identityOutput);

  const ascApiKeyPath = (process.env.APPLE_API_KEY || "").trim();
  const ascApiKeyId = (process.env.APPLE_API_KEY_ID || "").trim();
  const ascApiIssuer = (process.env.APPLE_API_ISSUER || "").trim();
  const hasAscApiKey = ascApiKeyPath && ascApiKeyId && ascApiIssuer;

  const appleId = (process.env.APPLE_ID || "").trim();
  const appSpecificPassword = (process.env.APPLE_APP_SPECIFIC_PASSWORD || "").trim();
  const appleTeamId = (process.env.APPLE_TEAM_ID || "").trim();
  const hasApplePasswordTrio = appleId && appSpecificPassword && appleTeamId;

  const hasNotaryCreds = hasAscApiKey || hasApplePasswordTrio;

  const explicitAdHoc =
    String(process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "").toLowerCase() === "false";

  if (!hasDeveloperIdCert || explicitAdHoc) {
    return {
      mode: "ad-hoc",
      extraArgs: [],
      extraEnv: {
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        GETIT_MAC_SIGNING_MODE: "ad-hoc",
      },
    };
  }

  if (!hasNotaryCreds) {
    return {
      mode: "developer-id-no-notary",
      extraArgs: [
        "--config.mac.hardenedRuntime=true",
        "--config.mac.notarize=false",
      ],
      extraEnv: { GETIT_MAC_SIGNING_MODE: "developer-id-no-notary" },
    };
  }

  return {
    mode: "developer-id",
    extraArgs: [
      "--config.mac.hardenedRuntime=true",
      "--config.mac.notarize=true",
    ],
    extraEnv: { GETIT_MAC_SIGNING_MODE: "developer-id" },
  };
}

function describeMacSigningMode(mode) {
  switch (mode) {
    case "developer-id":
      return "Developer ID signing + Apple notarization (Gatekeeper-clean download)";
    case "developer-id-no-notary":
      return "Developer ID signing only (no notary creds — first-launch prompt remains)";
    case "ad-hoc":
      return "ad-hoc signature (no Developer ID cert; System Settings bypass required first time)";
    default:
      return mode;
  }
}

async function buildOne(targetKey) {
  const t = TARGETS[targetKey];
  if (!t) throw new Error(`Unknown target ${targetKey}. Known: ${Object.keys(TARGETS).join(", ")}`);
  console.log(`\n=== Building ${targetKey} ===`);
  await run("node", [
    path.join("scripts", "electron-prepare.mjs"),
    `--target=${t.prepareTriple}`,
  ]);

  const isMacTarget = targetKey === "mac-arm64" || targetKey === "mac-x64";
  const signing = isMacTarget
    ? resolveMacSigningMode()
    : { mode: "not-mac", extraArgs: [], extraEnv: {} };

  if (isMacTarget) {
    console.log(`    signing: ${describeMacSigningMode(signing.mode)}`);
  }

  // package.json#version is only rewritten from the tag by the release
  // workflow, so a local checkout still says 0.0.0. Stamp the resolved
  // version into the packaged app instead: extraMetadata flows into the
  // bundled package.json (what app.getVersion() reads), the installer
  // metadata and the artefact filename.
  const appVersion = resolveAppVersion();
  console.log(`    version: ${appVersion}`);

  await run(
    "npx",
    [
      "--no-install",
      "electron-builder",
      ...t.builderFlag,
      "--publish",
      "never",
      `--config.extraMetadata.version=${appVersion}`,
      ...signing.extraArgs,
    ],
    { env: { ...process.env, ...signing.extraEnv } },
  );
  console.log(`=== ${targetKey} done ===`);
}

async function main() {
  if (all) {
    for (const k of ["mac-arm64", "mac-x64", "win-x64", "linux-x64"]) {
      await buildOne(k);
    }
    return;
  }
  if (!targetArg) {
    console.error("Provide --target=<key> or --all. Known targets:", Object.keys(TARGETS).join(", "));
    process.exit(1);
  }
  await buildOne(targetArg);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

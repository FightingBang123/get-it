"use strict";

/**
 * Single source of truth for the version stamped into a build.
 *
 * package.json#version is the authoritative field for releases: the
 * release workflow rewrites it from the pushed git tag before `next
 * build` runs, so `next build`, electron-builder and the in-app chip all
 * agree. A working checkout, however, keeps it at "0.0.0" — which made
 * every locally built desktop app report version 0.0.0, and the updater
 * then treated every published release as newer and prompted on every
 * single launch.
 *
 * So when package.json still says 0.0.0 we fall back to the nearest
 * reachable release tag (`git describe`, prerelease tags excluded). If
 * git is unavailable — a tarball, a shallow CI checkout that skipped the
 * pinning step — we return "0.0.0" and the updater treats the build as
 * unknown and skips the check entirely.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

function declaredVersion() {
  try {
    const pkg = require(path.join(REPO_ROOT, "package.json"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function tagVersion() {
  try {
    // `--exclude "*-*"` drops prerelease tags like v1.4.0-preview: an
    // unversioned local build should not claim to be a prerelease it
    // cannot be updated from.
    const tag = execFileSync(
      "git",
      ["describe", "--tags", "--abbrev=0", "--exclude", "*-*"],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return tag.replace(/^v/, "") || null;
  } catch {
    return null;
  }
}

function resolveAppVersion() {
  const declared = declaredVersion();
  if (declared !== "0.0.0") return declared;
  return tagVersion() || "0.0.0";
}

module.exports = { resolveAppVersion };

/**
 * Single source of truth for every on-disk path the app uses.
 *
 * Resolution order for the root data directory:
 *   1. `GETIT_DATA_DIR` env var — set by the Electron main process to
 *      `app.getPath('userData')` so the packaged app stores data in the
 *      conventional OS location (e.g. ~/Library/Application Support/get-it).
 *   2. A stable per-OS user-data folder under the user's home. We pick the
 *      same convention Electron itself would pick so the dev experience
 *      matches the packaged one even without setting the env var.
 *
 * NEVER fall back to os.tmpdir(): on macOS /tmp is wiped at reboot and on
 * Windows it lives under %LOCALAPPDATA%\Temp where files can disappear
 * without warning. Persistent data belongs in the user-data dir.
 *
 * Layout:
 *   <DATA_DIR>/
 *     docs.json                       — index of all docs (id, filename, …)
 *     docs/<docId>/source.pdf         — original PDF bytes
 *     docs/<docId>/meta.json          — { id, filename, uploadedAt, numPages }
 *     docs/<docId>/extracted.json     — cached pdf-extract output
 *     docs/<docId>/workctx.json       — chat / flashcards / quizzes / feynman journal
 *     docs/<docId>/kg.json            — knowledge graph
 *     docs/<docId>/tags.json          — server-side persisted visualizer tags
 *     codex-scratch/                  — AI CLI working dir (used by all providers)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DOC_ID_RE = /^[a-z0-9-]{1,64}$/;
function assertValidDocId(docId: string): void {
  if (!DOC_ID_RE.test(docId)) {
    throw new Error(`Invalid docId: ${docId}`);
  }
}

const APP_DIR_NAME = "get-it";

function defaultUserDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", APP_DIR_NAME);
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        APP_DIR_NAME,
      );
    default:
      // Linux & friends. Honour XDG_DATA_HOME, fall back to the spec default.
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        APP_DIR_NAME,
      );
  }
}

export const DATA_DIR: string = process.env.GETIT_DATA_DIR
  ? path.resolve(process.env.GETIT_DATA_DIR)
  : defaultUserDataDir();

export const DOCS_DIR = path.join(DATA_DIR, "docs");
export const DOCS_INDEX_PATH = path.join(DATA_DIR, "docs.json");
export const CODEX_SCRATCH_DIR = path.join(DATA_DIR, "codex-scratch");
/** Preferred alias — same directory, provider-neutral name. */
export const SCRATCH_DIR = CODEX_SCRATCH_DIR;

// Eagerly ensure the top-level directories exist. fs.mkdirSync with
// recursive:true is a no-op when they're already there.
fs.mkdirSync(DOCS_DIR, { recursive: true });
fs.mkdirSync(CODEX_SCRATCH_DIR, { recursive: true });

export function docDir(docId: string): string {
  assertValidDocId(docId);
  return path.join(DOCS_DIR, docId);
}

export function pdfPath(docId: string): string {
  assertValidDocId(docId);
  return path.join(docDir(docId), "source.pdf");
}

export function metaPath(docId: string): string {
  assertValidDocId(docId);
  return path.join(docDir(docId), "meta.json");
}

export function extractedPath(docId: string): string {
  assertValidDocId(docId);
  return path.join(docDir(docId), "extracted.json");
}

export function workCtxPath(docId: string): string {
  assertValidDocId(docId);
  return path.join(docDir(docId), "workctx.json");
}

export function kgPath(docId: string): string {
  assertValidDocId(docId);
  return path.join(docDir(docId), "kg.json");
}

export function tagsPath(docId: string): string {
  assertValidDocId(docId);
  return path.join(docDir(docId), "tags.json");
}

/** Cached page-chunk index used to keep every model call within its input
 *  budget (see lib/doc-chunks.ts). */
export function chunksPath(docId: string): string {
  assertValidDocId(docId);
  return path.join(docDir(docId), "chunks.json");
}

export function ensureDocDir(docId: string): void {
  assertValidDocId(docId);
  fs.mkdirSync(docDir(docId), { recursive: true });
}

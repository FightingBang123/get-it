/**
 * Persistent document store.
 *
 * Each doc lives in its own folder under <DATA_DIR>/docs/<docId>/ — see
 * lib/paths.ts for the full layout. A global index at <DATA_DIR>/docs.json
 * lists every known doc so the Library page can render the catalog
 * without scanning the filesystem.
 *
 * In-memory cache:
 *   We keep a Map<docId, StoreEntry> for hot lookups (analyze-pdf, chat,
 *   etc. all read .extracted on every request). On a cache miss we lazy-
 *   load meta + cached extraction from disk. That makes the store
 *   resilient to server restarts and to a cold Electron launch.
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DOCS_INDEX_PATH,
  docDir,
  ensureDocDir,
  extractedPath,
  metaPath,
} from "./paths";
import type { ExtractedPdf } from "./pdf-extract";

export { pdfPath } from "./paths";

export type DocMeta = {
  id: string;
  filename: string;
  uploadedAt: number;
  numPages: number;
  /** Detected at import (lib/material-kind.ts); drives prompt selection. */
  materialKind?: import("../prompt/types").MaterialKind;
  /** Epoch ms — last time the doc was opened in the viewer. Null until
   *  the user first opens it. Updated via `touchDoc(id)` (called from
   *  POST /api/doc/[id]/touch). */
  lastOpenedAt?: number | null;
};

type StoreEntry = DocMeta & {
  extracted: ExtractedPdf;
  /** Public URL the client can fetch the raw PDF from. */
  pdfUrl: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __getitStore: Map<string, StoreEntry> | undefined;
}

const store: Map<string, StoreEntry> =
  globalThis.__getitStore ?? (globalThis.__getitStore = new Map());

export function newDocId(): string {
  return randomUUID();
}

// ── Docs index (on-disk catalog of every known doc) ────────────────────

function readIndex(): DocMeta[] {
  try {
    const raw = fs.readFileSync(DOCS_INDEX_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { v: number; docs: DocMeta[] };
    if (parsed && parsed.v === 1 && Array.isArray(parsed.docs)) {
      return parsed.docs;
    }
  } catch {
    /* fresh install or malformed file — start empty */
  }
  return [];
}

function writeIndex(docs: DocMeta[]): void {
  const tmp = `${DOCS_INDEX_PATH}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, docs }, null, 2));
  fs.renameSync(tmp, DOCS_INDEX_PATH);
}

export function listDocs(): DocMeta[] {
  // Sort newest first so the Library renders in reverse-chronological order.
  return readIndex().slice().sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function upsertIndex(meta: DocMeta): void {
  const docs = readIndex();
  const idx = docs.findIndex((d) => d.id === meta.id);
  if (idx >= 0) docs[idx] = meta;
  else docs.push(meta);
  writeIndex(docs);
}

function removeFromIndex(docId: string): void {
  const docs = readIndex().filter((d) => d.id !== docId);
  writeIndex(docs);
}

// ── Save / load / delete ───────────────────────────────────────────────

export function saveDoc(entry: StoreEntry): void {
  ensureDocDir(entry.id);
  const meta: DocMeta = {
    id: entry.id,
    filename: entry.filename,
    uploadedAt: entry.uploadedAt,
    numPages: entry.numPages,
    materialKind: entry.materialKind,
  };
  const writeAtomic = (p: string, data: unknown) => {
    const tmp = `${path.dirname(p)}/${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, p);
  };
  writeAtomic(extractedPath(entry.id), entry.extracted);
  writeAtomic(metaPath(entry.id), meta);
  upsertIndex(meta);
  store.set(entry.id, entry);
}

function lazyLoadFromDisk(docId: string): StoreEntry | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(docId), "utf-8")) as DocMeta;
    const extracted = JSON.parse(
      fs.readFileSync(extractedPath(docId), "utf-8"),
    ) as ExtractedPdf;
    const entry: StoreEntry = {
      ...meta,
      extracted,
      pdfUrl: `/api/pdf/${docId}`,
    };
    store.set(docId, entry);
    return entry;
  } catch {
    return undefined;
  }
}

export function getDoc(id: string): StoreEntry | undefined {
  return store.get(id) ?? lazyLoadFromDisk(id);
}

/**
 * Bump the "last opened" timestamp on a doc and persist it both in
 * meta.json and in the global docs index. Cheap (one JSON write each)
 * and idempotent enough to call on every viewer mount. Library
 * surfaces this via `lastActivityAt`.
 */
export function touchDoc(docId: string): DocMeta | null {
  const docs = readIndex();
  const idx = docs.findIndex((d) => d.id === docId);
  if (idx < 0) return null;
  const now = Date.now();
  const next: DocMeta = { ...docs[idx], lastOpenedAt: now };
  docs[idx] = next;
  writeIndex(docs);
  // Mirror onto meta.json so lazy-load picks it up after a restart.
  try {
    fs.writeFileSync(metaPath(docId), JSON.stringify(next, null, 2));
  } catch {
    /* ignore — index is authoritative */
  }
  const cached = store.get(docId);
  if (cached) {
    cached.lastOpenedAt = now;
  }
  return next;
}

export function deleteDoc(docId: string): boolean {
  let removed = false;
  try {
    fs.rmSync(docDir(docId), { recursive: true, force: true });
    removed = true;
  } catch {
    /* ignore */
  }
  store.delete(docId);
  removeFromIndex(docId);
  return removed;
}

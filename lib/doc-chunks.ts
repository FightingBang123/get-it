/**
 * Page-aligned chunks of a document, sized to a token budget.
 *
 * Chunking on page boundaries (with a one-page overlap) keeps every citation
 * the agents emit — `[page n]`, concept `pageHints` — anchored to the real
 * document, while giving every downstream call a bounded amount of text.
 *
 * The index is deterministic for a given document, so the prompt prefix stays
 * cacheable across calls, and it is cached on disk because a 350-page book is
 * re-chunked on every KG rebuild otherwise.
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chunksPath } from "./paths";
import { DOC_CHUNK_TOKENS, estimateTokens } from "./context-budget";

export type DocChunk = {
  index: number;
  /** 1-based inclusive page range. */
  pageStart: number;
  pageEnd: number;
  tokens: number;
  text: string;
};

type CacheFile = {
  v: 1;
  pageCount: number;
  chars: number;
  chunks: DocChunk[];
};

type PageBlob = { page: number; text: string; tokens: number };

function pageBlobs(pages: { pageIndex: number; text: string }[]): PageBlob[] {
  const blobs: PageBlob[] = [];
  for (const page of pages) {
    const text = `[page ${page.pageIndex + 1}]\n${page.text.trim()}`;
    if (!page.text.trim()) continue;
    blobs.push({ page: page.pageIndex + 1, text, tokens: estimateTokens(text) });
  }
  return blobs;
}

export function buildDocChunks(
  pages: { pageIndex: number; text: string }[],
  maxTokens = DOC_CHUNK_TOKENS,
): DocChunk[] {
  const blobs = pageBlobs(pages);
  const chunks: DocChunk[] = [];

  let i = 0;
  while (i < blobs.length) {
    const picked: PageBlob[] = [];
    let used = 0;
    while (i < blobs.length) {
      const next = blobs[i];
      if (picked.length > 0 && used + next.tokens > maxTokens) break;
      picked.push(next);
      used += next.tokens;
      i++;
    }

    chunks.push({
      index: chunks.length,
      pageStart: picked[0].page,
      pageEnd: picked[picked.length - 1].page,
      tokens: used,
      text: picked.map((b) => b.text).join("\n\n"),
    });

    // Overlap one page into the next chunk so a concept split across a page
    // boundary is still visible to at least one map call. A single oversized
    // page is never carried back — that would loop forever.
    if (i < blobs.length && picked.length > 1) i -= 1;
  }

  return chunks;
}

/** Character count used as the cache fingerprint. */
function totalChars(pages: { text: string }[]): number {
  let n = 0;
  for (const page of pages) n += page.text.length;
  return n;
}

export function loadDocChunks(
  docId: string,
  pages: { pageIndex: number; text: string }[],
  maxTokens = DOC_CHUNK_TOKENS,
): DocChunk[] {
  const fingerprint = { pageCount: pages.length, chars: totalChars(pages) };
  const file = chunksPath(docId);

  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf-8")) as CacheFile;
    if (
      cached.v === 1 &&
      cached.pageCount === fingerprint.pageCount &&
      cached.chars === fingerprint.chars &&
      Array.isArray(cached.chunks)
    ) {
      return cached.chunks;
    }
  } catch {
    /* missing or stale — rebuild */
  }

  const chunks = buildDocChunks(pages, maxTokens);
  try {
    const tmp = `${file}.${randomUUID()}.tmp`;
    const payload: CacheFile = { v: 1, ...fingerprint, chunks };
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
  } catch {
    /* the cache is an optimisation; never fail a build over it */
  }
  return chunks;
}

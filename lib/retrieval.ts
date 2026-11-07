/**
 * Query-time retrieval over the document's chunk index.
 *
 * Study tools used to receive the whole document. For a 350-page book that is
 * both unaffordable and counter-productive: the model spends its context on
 * material the question never touches. This module picks a handful of page
 * chunks instead — by relevance to the student's question, or evenly across
 * the book when the request is "the whole document".
 *
 * Short documents are returned in full, exactly as before, so nothing changes
 * for a handout that already fits the budget.
 */

import {
  KG_SINGLE_CALL_TOKENS,
  takeWithinBudget,
} from "./context-budget";
import { loadDocChunks, type DocChunk } from "./doc-chunks";
import { loadSettings } from "./settings-store";
import type { KnowledgeGraph } from "./kg-types";

export type RetrievalTool = "chat" | "flashcards" | "quizzes" | "feynman";

export type RetrievalConfig = {
  /** Maximum chunks selected for one request. */
  maxChunks: number;
  /** Total token budget for the excerpts block. */
  maxTokens: number;
  /** Chat turns (user + assistant pairs) that take part in the query. */
  historyTurns: number;
};

export const RETRIEVAL_DEFAULTS: RetrievalConfig = {
  maxChunks: 4,
  // Must fit at least two ~10k-token chunks, otherwise "whole document"
  // coverage degenerates to a single chunk.
  maxTokens: 24_000,
  historyTurns: 2,
};

export type RetrievalRequest = {
  docId: string;
  pages: { pageIndex: number; text: string }[];
  kg?: KnowledgeGraph | null;
  tool: RetrievalTool;
  /** Free-text topic for flashcards / quizzes / feynman. "all" means the
   *  whole document. */
  topic?: string;
  /** The student's newest message (chat only). */
  message?: string;
  /** Prior turns, oldest first (chat only). */
  history?: { role: string; content: string }[];
};

export type DocumentContext = {
  /** Ready to drop into a prompt, after "DOCUMENT: …" / "DOCUMENT TEXT:". */
  text: string;
  mode: "full" | "relevance" | "coverage";
  /** Human-readable ranges, for logs and debugging. */
  pageRanges: string;
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Defaults overridden by the optional `retrieval` block in settings.json. */
export function retrievalConfig(): RetrievalConfig {
  const override = loadSettings().retrieval ?? {};
  return {
    maxChunks: clampInt(override.maxChunks, 1, 12, RETRIEVAL_DEFAULTS.maxChunks),
    maxTokens: clampInt(override.maxTokens, 2_000, 60_000, RETRIEVAL_DEFAULTS.maxTokens),
    historyTurns: clampInt(override.historyTurns, 0, 10, RETRIEVAL_DEFAULTS.historyTurns),
  };
}

// ── Query construction ─────────────────────────────────────────────────

type Query = {
  text: string;
  mode: "relevance" | "coverage";
  boostPages: number[];
};

function nodePagesForLabel(kg: KnowledgeGraph | null | undefined, topic: string): number[] {
  if (!kg || kg.status !== "ready") return [];
  const needle = topic.trim().toLowerCase();
  if (!needle) return [];
  const pages = new Set<number>();
  for (const node of kg.nodes) {
    const label = node.label.toLowerCase();
    if (node.id === needle || label === needle || label.includes(needle) || needle.includes(label)) {
      for (const p of node.pageHints ?? []) pages.add(p);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

function nodePagesMentioned(kg: KnowledgeGraph | null | undefined, text: string): number[] {
  if (!kg || kg.status !== "ready") return [];
  const haystack = text.toLowerCase();
  const pages = new Set<number>();
  for (const node of kg.nodes) {
    if (node.label.length >= 2 && haystack.includes(node.label.toLowerCase())) {
      for (const p of node.pageHints ?? []) pages.add(p);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

export function buildQuery(req: RetrievalRequest, config = RETRIEVAL_DEFAULTS): Query {
  const topic = (req.topic ?? "").trim();

  if (req.tool !== "chat") {
    if (!topic || topic.toLowerCase() === "all") {
      return { text: "", mode: "coverage", boostPages: [] };
    }
    return {
      text: topic,
      mode: "relevance",
      boostPages: nodePagesForLabel(req.kg, topic),
    };
  }

  const recent = (req.history ?? [])
    .slice(-Math.max(1, config.historyTurns) * 2)
    .map((m) => m.content)
    .join(" ");
  const text = `${recent} ${req.message ?? ""}`.trim();
  if (!text) return { text: "", mode: "coverage", boostPages: [] };
  return {
    text,
    mode: "relevance",
    boostPages: nodePagesMentioned(req.kg, text),
  };
}

// ── Scoring ────────────────────────────────────────────────────────────

/** CJK has no spaces, so index bi-grams; Latin runs become lowercase words. */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const terms: string[] = [];
  for (const match of lowered.matchAll(/[a-z0-9]{2,}/g)) terms.push(match[0]);
  for (const run of lowered.match(/[㐀-䶿一-鿿]+/g) ?? []) {
    if (run.length === 1) terms.push(run);
    for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

function overlapsPages(chunk: DocChunk, pages: number[]): boolean {
  for (const p of pages) {
    if (p >= chunk.pageStart && p <= chunk.pageEnd) return true;
  }
  return false;
}

/** Evenly spaced chunks so "the whole document" still covers the book. */
export function pickCoverage(chunks: DocChunk[], maxChunks: number): DocChunk[] {
  if (chunks.length <= maxChunks) return chunks;
  const picked: DocChunk[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < maxChunks; i++) {
    const index = Math.round((i * (chunks.length - 1)) / Math.max(1, maxChunks - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    picked.push(chunks[index]);
  }
  return picked;
}

export function rankChunks(
  chunks: DocChunk[],
  query: string,
  boostPages: number[],
  maxChunks: number,
): DocChunk[] {
  const terms = [...new Set(tokenize(query))].slice(0, 64);
  if (terms.length === 0) return pickCoverage(chunks, maxChunks);

  const docs = chunks.map((chunk) => ({
    chunk,
    text: chunk.text.toLowerCase(),
    length: chunk.text.length,
  }));
  const avgLength =
    docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length);

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let n = 0;
    for (const doc of docs) if (doc.text.includes(term)) n++;
    documentFrequency.set(term, n);
  }

  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of terms) {
      const tf = countOccurrences(doc.text, term);
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      // BM25-ish saturation; document length normalisation is gentle.
      const weight =
        (tf / (tf + 1.2 * (0.25 + 0.75 * (doc.length / Math.max(1, avgLength))))) * idf;
      score += weight;
    }
    if (boostPages.length > 0 && overlapsPages(doc.chunk, boostPages)) {
      score += 1.5;
    }
    return { chunk: doc.chunk, score };
  });

  const relevant = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
    .slice(0, maxChunks)
    .map((s) => s.chunk);

  return relevant.length > 0 ? relevant : pickCoverage(chunks, maxChunks);
}

// ── Public ─────────────────────────────────────────────────────────────

function fullText(pages: { pageIndex: number; text: string }[]): string {
  return pages
    .map((p) => `[page ${p.pageIndex + 1}]\n${p.text}`)
    .join("\n\n");
}

function renderExcerpts(chunks: DocChunk[], totalPages: number): string {
  const ranges = chunks.map((c) => `${c.pageStart}–${c.pageEnd}`).join(", ");
  return `DOCUMENT EXCERPTS (pages ${ranges} of ${totalPages}; only the passages most relevant to this request are included — cite page numbers from them):
${chunks.map((c) => c.text).join("\n\n")}`;
}

export function buildDocumentContext(
  req: RetrievalRequest,
  config = retrievalConfig(),
): DocumentContext {
  const chunks = loadDocChunks(req.docId, req.pages);
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
  const lastPage = req.pages.length;

  if (totalTokens <= KG_SINGLE_CALL_TOKENS) {
    return {
      text: fullText(req.pages),
      mode: "full",
      pageRanges: `1–${lastPage}`,
    };
  }

  const query = buildQuery(req, config);

  // How many chunks actually fit the token budget? Coverage must sample that
  // many evenly (picking 4 and then truncating to 1 would always send the
  // opening pages), and relevance never needs to consider more.
  const averageTokens = totalTokens / Math.max(1, chunks.length);
  const fits = Math.max(1, Math.floor(config.maxTokens / Math.max(1, averageTokens)));
  const wanted = Math.min(config.maxChunks, fits);

  const selected =
    query.mode === "coverage"
      ? pickCoverage(chunks, wanted)
      : rankChunks(chunks, query.text, query.boostPages, wanted);
  const kept = takeWithinBudget(
    selected.map((chunk) => ({ chunk, text: chunk.text })),
    config.maxTokens,
    (b) => b.chunk.tokens,
  ).map((b) => b.chunk);

  const final = kept.length > 0 ? kept : [selected[0] ?? chunks[0]];
  return {
    text: renderExcerpts(final, lastPage),
    mode: query.mode,
    pageRanges: final.map((c) => `${c.pageStart}–${c.pageEnd}`).join(", "),
  };
}

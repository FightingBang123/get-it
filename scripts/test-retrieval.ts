/**
 * Tests for query-time retrieval (lib/retrieval.ts).
 *
 * Run: npm run test:retrieval
 *
 * Pure: no provider, no network, no tokens. Covers query construction,
 * scoring, coverage sampling, and the full/short-document passthrough.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function checkEqual(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, expected ${String(expected)}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "getit-retrieval-"));
  process.env.GETIT_DATA_DIR = tmp;

  const { tokenize, rankChunks, pickCoverage, buildQuery, buildDocumentContext } =
    await import("../lib/retrieval");
  const { buildDocChunks } = await import("../lib/doc-chunks");
  const { estimateTokens, DOC_CHUNK_TOKENS } = await import("../lib/context-budget");

  // 1) Tokenizer: Latin words + CJK bi-grams.
  {
    const terms = tokenize("Photosynthesis 光合作用");
    check("latin term indexed", terms.includes("photosynthesis"));
    check("cjk bi-grams indexed", terms.includes("光合") && terms.includes("合作"));
    check("no single-char cjk noise", !terms.includes("光"));
  }

  // 2) Ranking puts the chunk that mentions the query first.
  {
    const pages = Array.from({ length: 40 }, (_, i) => ({
      pageIndex: i,
      text: i === 19 ? "zebra migration across the savanna " + "filler ".repeat(200) : "中".repeat(800),
    }));
    const chunks = buildDocChunks(pages);
    const ranked = rankChunks(chunks, "zebra migration", [], 2);
    check("query hit ranks first", ranked[0].pageStart <= 20 && ranked[0].pageEnd >= 20, `${ranked[0].pageStart}-${ranked[0].pageEnd}`);
  }

  // 3) Unmatched queries fall back to coverage instead of returning nothing.
  {
    const chunks = buildDocChunks(Array.from({ length: 40 }, (_, i) => ({ pageIndex: i, text: "中".repeat(800) })));
    const ranked = rankChunks(chunks, "quantum entanglement", [], 2);
    checkEqual("no-hit query falls back to coverage", ranked.length, 2);
  }

  // 4) Coverage sampling spans the document.
  {
    const chunks = buildDocChunks(Array.from({ length: 40 }, (_, i) => ({ pageIndex: i, text: "中".repeat(800) })));
    const picked = pickCoverage(chunks, 4);
    checkEqual("coverage picks the requested count", picked.length, 4);
    checkEqual("coverage starts at the first chunk", picked[0].pageStart, 1);
    checkEqual("coverage ends at the last chunk", picked[picked.length - 1].pageEnd, 40);
    check("coverage has no duplicates", new Set(picked.map((c) => c.index)).size === picked.length);
  }

  // 5) Query construction per tool.
  {
    const kg = {
      v: 1 as const,
      docId: "d",
      status: "ready" as const,
      buildAt: 0,
      lastEvaluatedAt: null,
      evaluationCount: 0,
      nodes: [
        { id: "photosynthesis", label: "Photosynthesis", summary: "Light to sugar.", pageHints: [4, 5], evaluation: { memory: 0, comprehension: 0, structure: 0, application: 0 }, evaluatorNote: "" },
      ],
      edges: [],
      globalNote: "note here",
    };

    const all = buildQuery({ docId: "d", pages: [], tool: "flashcards", topic: "all", kg });
    checkEqual("topic all → coverage", all.mode, "coverage");

    const topic = buildQuery({ docId: "d", pages: [], tool: "flashcards", topic: "Photosynthesis", kg });
    checkEqual("topic → relevance", topic.mode, "relevance");
    check("topic matching a KG node boosts its pages", topic.boostPages.includes(4));

    const chat = buildQuery({
      docId: "d",
      pages: [],
      tool: "chat",
      message: "what does photosynthesis produce?",
      history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
      kg,
    });
    check("chat query uses the message", chat.text.includes("photosynthesis"));
    check("chat boosts the mentioned concept", chat.boostPages.includes(4));
  }

  // 6) Short documents are passed through whole.
  {
    const pages = [{ pageIndex: 0, text: "page one" }, { pageIndex: 1, text: "page two" }];
    const ctx = buildDocumentContext({ docId: "short", pages, tool: "chat", message: "hi" });
    checkEqual("short doc → full mode", ctx.mode, "full");
    check("short doc keeps every page", ctx.text.includes("page one") && ctx.text.includes("page two"));
  }

  // 7) Long documents are excerpted, bounded, and still cite real pages.
  {
    const pages = Array.from({ length: 40 }, (_, i) => ({
      pageIndex: i,
      text: i === 25 ? "zebra migration across the savanna " + "filler ".repeat(200) : "中".repeat(800),
    }));
    const ctx = buildDocumentContext({
      docId: "long",
      pages,
      tool: "flashcards",
      topic: "zebra migration",
    });
    checkEqual("long doc → relevance mode", ctx.mode, "relevance");
    check("excerpt includes the matching page", ctx.text.includes("[page 26]"), ctx.text.slice(0, 80));
    check("excerpt is bounded", estimateTokens(ctx.text) <= DOC_CHUNK_TOKENS * 2, String(estimateTokens(ctx.text)));
    check("excerpt header explains it is partial", ctx.text.startsWith("DOCUMENT EXCERPTS"));
  }

  // 8) "Whole document" on a long doc uses coverage, not relevance.
  {
    const pages = Array.from({ length: 40 }, (_, i) => ({ pageIndex: i, text: "中".repeat(800) }));
    const ctx = buildDocumentContext({ docId: "long2", pages, tool: "quizzes", topic: "all" });
    checkEqual("topic all on a long doc → coverage", ctx.mode, "coverage");
    check("coverage spans the book", ctx.pageRanges.includes("–"), ctx.pageRanges);
  }

  // 9) Settings override is honoured.
  {
    fs.writeFileSync(
      path.join(tmp, "settings.json"),
      JSON.stringify({ v: 2, provider: "pi", retrieval: { maxChunks: 2, maxTokens: 4000 } }),
    );
    const { retrievalConfig } = await import("../lib/retrieval");
    const cfg = retrievalConfig();
    checkEqual("settings maxChunks honoured", cfg.maxChunks, 2);
    checkEqual("settings maxTokens honoured", cfg.maxTokens, 4000);
    checkEqual("unspecified historyTurns falls back", cfg.historyTurns, 2);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

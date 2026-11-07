/**
 * Tests for the long-context layer used by the knowledge-graph build.
 *
 * Run: npm run test:budget
 *
 * These are pure: no provider, no network, no tokens. They cover the parts
 * that decide whether a long document can be processed at all —
 *   • token estimation and chunking (lib/context-budget.ts, lib/doc-chunks.ts)
 *   • candidate merging (lib/kg-build.ts)
 *   • the map-reduce orchestration, driven by a fake runner, so we can assert
 *     every prompt stays inside the budget and that partial failures degrade
 *     gracefully.
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
  // Point the data dir at a scratch folder BEFORE importing anything that
  // reads lib/paths.ts, so the chunk cache never touches the real app data.
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "getit-chunks-"));
  process.env.GETIT_DATA_DIR = tmpDataDir;

  const budget = await import("../lib/context-budget");
  const { estimateTokens, DOC_CHUNK_TOKENS, takeWithinBudget, mapLimit } = budget;
  const { buildDocChunks, loadDocChunks } = await import("../lib/doc-chunks");
  const { mergeCandidates, buildGraphInParts, buildReducePrompt } = await import("../lib/kg-build");

  // 1) Token estimation: CJK ≈ 1/char, Latin ≈ 0.3/char.
  {
    checkEqual("empty string is 0 tokens", estimateTokens(""), 0);
    const cjk = estimateTokens("中".repeat(1000));
    check("1000 CJK chars ≈ 1000 tokens", cjk >= 990 && cjk <= 1010, String(cjk));
    const latin = estimateTokens("a".repeat(1000));
    check("1000 latin chars ≈ 300 tokens", latin === 300, String(latin));
    check("estimate is monotonic", estimateTokens("中文abc") > estimateTokens("中abc"));
  }

  // 2) takeWithinBudget keeps priority order and always keeps one block.
  {
    const blocks = [{ text: "x".repeat(100) }, { text: "y".repeat(100) }, { text: "z".repeat(100) }];
    checkEqual("budget takes what fits", takeWithinBudget(blocks, 65).length, 2);
    checkEqual("budget never returns empty", takeWithinBudget(blocks, 1).length, 1);
  }

  // 3) mapLimit preserves order and bounds concurrency.
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    check("mapLimit preserves order", out.join(",") === "2,4,6,8,10", out.join(","));
    check("mapLimit bounds concurrency", maxInFlight <= 2, String(maxInFlight));
  }

  // 4) Chunking: small documents stay in one chunk.
  {
    const pages = [1, 2, 3].map((i) => ({ pageIndex: i - 1, text: `page ${i} body` }));
    const chunks = buildDocChunks(pages);
    checkEqual("small doc → 1 chunk", chunks.length, 1);
    checkEqual("chunk page range", `${chunks[0].pageStart}-${chunks[0].pageEnd}`, "1-3");
  }

  // 5) Chunking: long documents split on page boundaries, within budget,
  //    covering every page, with a one-page overlap.
  {
    const pageText = "中".repeat(900); // ≈900 tokens per page
    const pages = Array.from({ length: 40 }, (_, i) => ({ pageIndex: i, text: pageText }));
    const chunks = buildDocChunks(pages);
    check("long doc → multiple chunks", chunks.length > 1, String(chunks.length));
    check(
      "every chunk within budget",
      chunks.every((c) => c.tokens <= DOC_CHUNK_TOKENS),
      chunks.map((c) => c.tokens).join(","),
    );
    checkEqual("first chunk starts at page 1", chunks[0].pageStart, 1);
    checkEqual("last chunk ends at the last page", chunks[chunks.length - 1].pageEnd, 40);
    check(
      "chunks overlap by exactly one page",
      chunks.every((c, i) => i === 0 || c.pageStart === chunks[i - 1].pageEnd),
      chunks.map((c) => `${c.pageStart}-${c.pageEnd}`).join(" "),
    );
  }

  // 6) A single page larger than the budget still terminates.
  {
    const pages = [{ pageIndex: 0, text: "中".repeat(DOC_CHUNK_TOKENS * 2) }, { pageIndex: 1, text: "中".repeat(50) }];
    const chunks = buildDocChunks(pages);
    checkEqual("oversized page forms its own chunk", chunks.length, 2);
    checkEqual("oversized page chunk starts at page 1", chunks[0].pageStart, 1);
  }

  // 7) Chunk cache round-trip.
  {
    const { docDir, ensureDocDir } = await import("../lib/paths");
    ensureDocDir("cache-test");
    const pages = [{ pageIndex: 0, text: "hello " + "world ".repeat(200) }];
    const first = loadDocChunks("cache-test", pages);
    const file = path.join(docDir("cache-test"), "chunks.json");
    check("chunk cache written", fs.existsSync(file));
    const second = loadDocChunks("cache-test", pages);
    check("cache hit returns identical chunks", JSON.stringify(first) === JSON.stringify(second));
    const changed = loadDocChunks("cache-test", [...pages, { pageIndex: 1, text: "new page" }]);
    check("cache invalidated when the document grows", changed.length >= first.length && changed[0].pageEnd >= 1);
  }

  // 8) Candidate merging: same label from different parts becomes one node.
  {
    const merged = mergeCandidates([
      {
        nodes: [
          { id: "entropy", label: "Entropy", summary: "A measure of disorder.", pageHints: [2, 3] },
          { id: "energy", label: "Energy", summary: "Capacity to do work.", pageHints: [1] },
        ],
        edges: [{ source: "entropy", target: "energy", relation: "relates to" }],
      },
      {
        nodes: [
          { id: "entropy-2", label: "entropy", summary: "Disorder in a closed system.", pageHints: [9] },
          { id: "cycle", label: "Cycle", summary: "A repeating process.", pageHints: [9] },
        ],
        edges: [{ source: "entropy-2", target: "cycle", relation: "drives" }],
      },
    ]);
    checkEqual("duplicate labels merged", merged.nodes.length, 3);
    const entropy = merged.nodes.find((n) => n.id === "entropy");
    check("page hints unioned", JSON.stringify(entropy?.pageHints) === "[2,3,9]", JSON.stringify(entropy?.pageHints));
    checkEqual("edges remapped to merged ids", merged.edges.length, 2);
    check(
      "edge endpoints survive",
      merged.edges.every((e) => merged.nodes.some((n) => n.id === e.source) && merged.nodes.some((n) => n.id === e.target)),
    );
  }

  // 9) Map-reduce orchestration with a fake runner.
  {
    const pages = Array.from({ length: 30 }, (_, i) => ({ pageIndex: i, text: "中".repeat(800) }));
    const chunks = buildDocChunks(pages);
    const prompts: string[] = [];
    let reduceCalls = 0;

    const result = await buildGraphInParts({ filename: "book.epub", chunks }, async <T>(prompt: string, schema: object): Promise<T> => {
      prompts.push(prompt);
      void schema;
      if (prompt.includes("--- CANDIDATES")) {
        reduceCalls++;
        return {
          nodes: [
            { id: "a", label: "A", summary: "Concept A summary.", pageHints: [1] },
            { id: "b", label: "B", summary: "Concept B summary.", pageHints: [2] },
            { id: "c", label: "C", summary: "Concept C summary.", pageHints: [3] },
            { id: "d", label: "D", summary: "Concept D summary.", pageHints: [4] },
          ],
          edges: [{ source: "a", target: "b", relation: "leads to" }],
          globalNote: "A short note about the whole book.",
        } as T;
      }
      return {
        nodes: [
          { id: "a", label: "A", summary: "Concept A summary.", pageHints: [1] },
          { id: "b", label: "B", summary: "Concept B summary.", pageHints: [2] },
        ],
        edges: [{ source: "a", target: "b", relation: "leads to" }],
      } as T;
    });

    checkEqual("map called once per chunk", prompts.length, chunks.length + 1);
    checkEqual("reduce called once", reduceCalls, 1);
    check(
      "every prompt stays within budget",
      prompts.every((p) => estimateTokens(p) <= DOC_CHUNK_TOKENS + 2_000),
      prompts.map((p) => estimateTokens(p)).join(","),
    );
    check("reduce prompt carries no document text", !prompts[prompts.length - 1].includes("中中中中中中中中"));
    checkEqual("final graph returned", result.nodes.length, 4);
  }

  // 10) Partial map failure degrades; total failure throws.
  {
    const chunks = buildDocChunks(Array.from({ length: 30 }, (_, i) => ({ pageIndex: i, text: "中".repeat(800) })));
    let calls = 0;
    const partial = await buildGraphInParts({ filename: "x", chunks }, async <T>(prompt: string): Promise<T> => {
      calls++;
      if (calls === 1) throw new Error("map boom");
      if (prompt.includes("CANDIDATES")) {
        return { nodes: [{ id: "a", label: "A", summary: "Concept A summary.", pageHints: [1] }], edges: [], globalNote: "note about the book" } as T;
      }
      return { nodes: [{ id: "a", label: "A", summary: "Concept A summary.", pageHints: [1] }], edges: [] } as T;
    });
    check("partial map failure still builds", partial.nodes.length >= 1);

    let threw = false;
    try {
      await buildGraphInParts({ filename: "x", chunks }, async () => {
        throw new Error("all maps fail");
      });
    } catch {
      threw = true;
    }
    check("total map failure throws", threw);
  }

  // 11) Reduce input is trimmed when candidates run long.
  {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      label: `Node ${i}`,
      summary: "A fairly long summary ".repeat(8),
      pageHints: [i + 1],
      count: 1,
    }));
    const prompt = buildReducePrompt("book", {
      nodes: many.slice(0, 30),
      edges: Array.from({ length: 80 }, (_, i) => ({ source: `n${i % 30}`, target: `n${(i + 1) % 30}`, relation: "rel" })),
    });
    check("reduce prompt respects its budget", estimateTokens(prompt) <= 8_500, String(estimateTokens(prompt)));
  }

  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Knowledge-graph construction for long documents.
 *
 * A single prompt containing a whole 350-page book is both unaffordable and
 * unreliable: the provider either rejects it or the CLI compacts mid-run.
 * Instead we run a map-reduce:
 *
 *   map    — one bounded call per chunk (see lib/doc-chunks.ts) extracting
 *            candidate concepts and relations from that part only;
 *   reduce — one small call over the merged candidate list (never over the
 *            document text) that dedupes, picks granularity, and writes the
 *            global note.
 *
 * Documents that fit in one call keep the original one-shot path; the caller
 * decides which path to take.
 */

import { MAP_CONCURRENCY, estimateTokens, mapLimit } from "./context-budget";
import type { DocChunk } from "./doc-chunks";
import {
  kgBuildSchema,
  kgMapSchema,
  type KGBuildResult,
  type KGMapResult,
} from "./schemas-kg";
import { systemPrompt } from "../prompt/registry";
import type { MaterialKind } from "../prompt/types";

/** Injected model call — keeps the orchestration testable without a provider. */
export type JsonRunner = <T>(prompt: string, schema: object) => Promise<T>;

const MAX_CANDIDATE_NODES = 30;
const MAX_CANDIDATE_EDGES = 80;
/** Reduce input is candidates only; trim further if the list runs long. */
const REDUCE_INPUT_BUDGET = 8_000;

export function buildPartPrompt(
  filename: string,
  chunk: DocChunk,
  partCount: number,
  kind: MaterialKind = "default",
): string {
  return `${systemPrompt("kg-map", kind)}

--- PART ${chunk.index + 1} OF ${partCount} (pages ${chunk.pageStart}–${chunk.pageEnd}) ---
${chunk.text}
--- END PART ---

Source document: ${filename}`;
}

type CandidateNode = {
  id: string;
  label: string;
  summary: string;
  pageHints: number[];
  count: number;
};

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function unionPages(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y).slice(0, 12);
}

/**
 * Merge per-part candidates. Exported for tests: it is the part of the
 * pipeline that decides whether the final graph is coherent.
 */
export function mergeCandidates(maps: KGMapResult[]): {
  nodes: CandidateNode[];
  edges: Array<{ source: string; target: string; relation: string }>;
} {
  const byKey = new Map<string, CandidateNode>();
  const edgeMap = new Map<string, { from: string; to: string; relation: string }>();

  for (const map of maps) {
    const idToKey = new Map<string, string>();

    for (const node of map.nodes ?? []) {
      const key = normalizeLabel(node.label) || node.id.toLowerCase();
      idToKey.set(node.id.toLowerCase(), key);
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        existing.pageHints = unionPages(existing.pageHints, node.pageHints ?? []);
        if ((node.summary ?? "").length > existing.summary.length) {
          existing.summary = node.summary;
        }
      } else {
        byKey.set(key, {
          id: node.id,
          label: node.label,
          summary: node.summary,
          pageHints: unionPages([], node.pageHints ?? []),
          count: 1,
        });
      }
    }

    for (const edge of map.edges ?? []) {
      const from = idToKey.get(edge.source.toLowerCase());
      const to = idToKey.get(edge.target.toLowerCase());
      if (!from || !to || from === to) continue;
      if (!edgeMap.has(`${from}→${to}`)) {
        edgeMap.set(`${from}→${to}`, { from, to, relation: edge.relation });
      }
    }
  }

  const nodes = [...byKey.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CANDIDATE_NODES);

  const kept = new Set(nodes.map((n) => normalizeLabel(n.label) || n.id.toLowerCase()));
  const edges = [...edgeMap.values()]
    .filter((e) => kept.has(e.from) && kept.has(e.to))
    .slice(0, MAX_CANDIDATE_EDGES)
    .map((e) => {
      const source = nodes.find((n) => (normalizeLabel(n.label) || n.id.toLowerCase()) === e.from)!;
      const target = nodes.find((n) => (normalizeLabel(n.label) || n.id.toLowerCase()) === e.to)!;
      return { source: source.id, target: target.id, relation: e.relation };
    });

  return { nodes, edges };
}

export function buildReducePrompt(
  filename: string,
  merged: ReturnType<typeof mergeCandidates>,
  kind: MaterialKind = "default",
): string {
  let nodes = merged.nodes;
  let edges = merged.edges;
  let payload = JSON.stringify({ nodes, edges }, null, 1);
  if (estimateTokens(payload) > REDUCE_INPUT_BUDGET) {
    nodes = nodes.slice(0, 24);
    edges = edges.slice(0, 40);
    payload = JSON.stringify({ nodes, edges }, null, 1);
  }
  return `${systemPrompt("kg-reduce", kind)}

--- CANDIDATES (from ${nodes.length} merged concepts) ---
${payload}
--- END CANDIDATES ---

Source document: ${filename}`;
}

/**
 * Map over every chunk, merge, then reduce. Map failures are tolerated as
 * long as at least one part produced candidates.
 */
export async function buildGraphInParts(
  args: { filename: string; chunks: DocChunk[]; materialKind?: MaterialKind },
  run: JsonRunner,
): Promise<KGBuildResult> {
  const partCount = args.chunks.length;
  const kind = args.materialKind ?? "default";
  const maps = await mapLimit(args.chunks, MAP_CONCURRENCY, async (chunk) => {
    try {
      return await run<KGMapResult>(
        buildPartPrompt(args.filename, chunk, partCount, kind),
        kgMapSchema,
      );
    } catch (err) {
      console.warn(
        `[kg-build] map call failed for pages ${chunk.pageStart}-${chunk.pageEnd}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  });

  const usable = maps.filter((m): m is KGMapResult => m !== null);
  if (usable.length === 0) {
    throw new Error("Knowledge graph build failed for every part of the document.");
  }

  const merged = mergeCandidates(usable);
  if (merged.nodes.length === 0) {
    throw new Error("Knowledge graph build found no concepts.");
  }

  return run<KGBuildResult>(
    buildReducePrompt(args.filename, merged, kind),
    kgBuildSchema,
  );
}

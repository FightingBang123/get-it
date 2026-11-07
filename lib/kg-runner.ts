/**
 * Server-side runners for the knowledge-graph agents.
 *
 * - buildKG(docId): one-shot creation of the concept graph from the PDF text.
 *   Idempotent — if a non-error KG already exists, returns it without
 *   touching codex.
 * - scheduleEvaluation(docId): debounced re-scoring of the existing graph
 *   based on the latest work context. Per-doc queue — at most one eval in
 *   flight, at most one pending after that — so chatty tools don't pile up
 *   redundant codex calls.
 *
 * Both runners are fire-and-forget from the caller's perspective; state is
 * committed to disk so the client polls /api/kg/[docId]/state to observe.
 */

import { runJson } from "./codex";
import { getDoc } from "./store";
import {
  emptyKG,
  loadKG,
  saveKG,
  type KGEvaluation,
  type KGNode,
  type KnowledgeGraph,
} from "./kg";
import {
  kgBuildSchema,
  kgEvaluateSchema,
  type KGBuildResult,
  type KGEvaluateResult,
} from "./schemas-kg";
import { KG_SINGLE_CALL_TOKENS } from "./context-budget";
import { loadDocChunks } from "./doc-chunks";
import { buildGraphInParts } from "./kg-build";
import { systemPrompt } from "../prompt/registry";
import type { MaterialKind } from "../prompt/types";
import {
  loadWorkContext,
  summariseForEvaluator,
  hasInteractionsSince,
} from "./work-context";

// ── Build prompt ──────────────────────────────────────────────────────

function buildPrompt(
  filename: string,
  pageBlobs: string[],
  kind: MaterialKind = "default",
): string {
  const text = pageBlobs.join("\n\n");
  // Stable instruction prefix first, variable document body last — keeps the
  // prompt prefix-cacheable and lets the model anchor on the rubric before it
  // reads the source.
  return `${systemPrompt("kg-build", kind)}

--- DOCUMENT (filename: ${filename}) ---
${text}
--- END DOCUMENT ---`;
}

/**
 * Join every page for the single-call path. Only used when the whole document
 * fits inside `KG_SINGLE_CALL_TOKENS`; longer documents go through the
 * chunked map-reduce in lib/kg-build.ts so no request ever carries the whole
 * book.
 */
function packPages(pages: { pageIndex: number; text: string }[]): string[] {
  return pages
    .map((p) => `[page ${p.pageIndex + 1}]\n${p.text.trim()}`)
    .filter((blob) => blob.length > 0);
}

// ── Public: build ────────────────────────────────────────────────────

const buildInFlight = new Map<string, Promise<KnowledgeGraph>>();

export function isBuilding(docId: string): boolean {
  return buildInFlight.has(docId);
}

export async function buildKG(docId: string): Promise<KnowledgeGraph> {
  // Reuse a result that's already on disk (idempotent at the API layer).
  const existing = loadKG(docId);
  if (existing && (existing.status === "ready" || existing.status === "building")) {
    if (existing.status === "ready") return existing;
  }
  const inFlight = buildInFlight.get(docId);
  if (inFlight) return inFlight;

  const promise = startBuild(docId);
  buildInFlight.set(docId, promise);
  promise.finally(() => {
    buildInFlight.delete(docId);
  }).catch(() => {});
  return promise;
}

async function startBuild(docId: string): Promise<KnowledgeGraph> {
  const doc = getDoc(docId);
  if (!doc) throw new Error("doc not found");

  const placeholder: KnowledgeGraph = {
    ...emptyKG(docId),
    status: "building",
  };
  saveKG(placeholder);

  try {
    const chunks = loadDocChunks(docId, doc.extracted.pages);
    const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);

    const data =
      totalTokens <= KG_SINGLE_CALL_TOKENS
        ? (
            await runJson<KGBuildResult>(
              buildPrompt(
                doc.filename,
                packPages(doc.extracted.pages),
                doc.materialKind,
              ),
              kgBuildSchema,
              { reasoning: "medium" },
            )
          ).data
        : await buildGraphInParts(
            {
              filename: doc.filename,
              chunks,
              materialKind: doc.materialKind,
            },
            async <T>(prompt: string, schema: object): Promise<T> => {
              const result = await runJson<T>(prompt, schema, {
                reasoning: "medium",
              });
              return result.data;
            },
          );

    const ids = new Set(data.nodes.map((n) => n.id));
    const cleanEdges = data.edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
    );
    const seen = new Set<string>();
    const dedupedEdges = cleanEdges.filter((e) => {
      const k = `${e.source}→${e.target}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const nodes: KGNode[] = data.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      summary: n.summary,
      pageHints: n.pageHints,
      evaluation: { memory: 0, comprehension: 0, structure: 0, application: 0 },
      evaluatorNote: "",
    }));

    const kg: KnowledgeGraph = {
      v: 1,
      docId,
      status: "ready",
      buildAt: Date.now(),
      lastEvaluatedAt: null,
      evaluationCount: 0,
      nodes,
      edges: dedupedEdges,
      globalNote: data.globalNote,
    };
    saveKG(kg);
    return kg;
  } catch (e) {
    const errored: KnowledgeGraph = {
      ...placeholder,
      status: "error",
      buildError: (e as Error).message,
    };
    saveKG(errored);
    return errored;
  }
}

// ── Evaluation ────────────────────────────────────────────────────────


function evaluatePrompt(
  kg: KnowledgeGraph,
  workCtxText: string,
  kind: MaterialKind = "default",
): string {
  const kgSummary = kg.nodes
    .map(
      (n) =>
        `- ${n.id} :: ${n.label} (M${n.evaluation.memory} C${n.evaluation.comprehension} S${n.evaluation.structure} A${n.evaluation.application})\n  ${n.summary}`,
    )
    .join("\n");
  const edgesSummary =
    kg.edges
      .slice(0, 80)
      .map((e) => `${e.source} -[${e.relation}]-> ${e.target}`)
      .join("\n") || "(no edges)";
  return `${systemPrompt("kg-evaluate", kind)}

--- KNOWLEDGE GRAPH (current scores in parens) ---
${kgSummary}

EDGES:
${edgesSummary}

GLOBAL NOTE (previous): ${kg.globalNote}

--- NEW INTERACTIONS SINCE LAST EVALUATION (chronological) ---
${workCtxText}
--- END NEW INTERACTIONS ---

Score now. Only emit nodes with new evidence. Never decrease.`;
}

function clampMonotone(prev: KGEvaluation, next: KGEvaluation): KGEvaluation {
  return {
    memory: Math.max(prev.memory, Math.min(100, Math.max(0, Math.round(next.memory)))),
    comprehension: Math.max(prev.comprehension, Math.min(100, Math.max(0, Math.round(next.comprehension)))),
    structure: Math.max(prev.structure, Math.min(100, Math.max(0, Math.round(next.structure)))),
    application: Math.max(prev.application, Math.min(100, Math.max(0, Math.round(next.application)))),
  };
}

const evalInFlight = new Map<string, Promise<void>>();
const evalPending = new Map<string, boolean>();

/** Whether an evaluation pass is currently running for this doc. Used by
 *  the state route so the client can render a live "evaluating" indicator
 *  without polling a separate endpoint. */
export function isEvaluating(docId: string): boolean {
  return evalInFlight.has(docId);
}

/**
 * Schedule an evaluation pass for a doc. Coalesces back-to-back calls into
 * at most one in-flight + one pending so a chatty tool can't queue dozens
 * of redundant codex turns.
 */
export function scheduleEvaluation(docId: string): void {
  if (evalInFlight.has(docId)) {
    evalPending.set(docId, true);
    return;
  }
  const run = (async () => {
    try {
      await runEvaluation(docId);
    } catch (e) {
      // Evaluation is best-effort background scoring. On any error (including
      // an account-level Codex error) we stop — no auto-retry. The next
      // genuine tool interaction schedules a fresh pass, and the health banner
      // explains an account-level failure in the meantime.
      console.warn("[kg-eval]", docId, (e as Error).message);
    } finally {
      evalInFlight.delete(docId);
      // Re-run only if a *new* interaction asked for one while we were busy.
      if (evalPending.get(docId)) {
        evalPending.delete(docId);
        scheduleEvaluation(docId);
      }
    }
  })();
  evalInFlight.set(docId, run);
}

async function runEvaluation(docId: string): Promise<void> {
  const kg = loadKG(docId);
  if (!kg || kg.status !== "ready") return;
  const workCtx = loadWorkContext(docId);

  // Only the interactions since the last pass matter — the baseline scores
  // carry everything earlier. If nothing is new, don't spend a Codex call.
  const sinceTs = kg.lastEvaluatedAt;
  if (!hasInteractionsSince(workCtx, sinceTs)) return;

  const promptText = evaluatePrompt(
    kg,
    summariseForEvaluator(workCtx, sinceTs),
    getDoc(docId)?.materialKind,
  );
  const { data } = await runJson<KGEvaluateResult>(promptText, kgEvaluateSchema, {
    reasoning: "medium",
  });

  // Apply updates with monotone clamping.
  const byId = new Map(kg.nodes.map((n) => [n.id, n]));
  for (const u of data.updates) {
    const node = byId.get(u.id);
    if (!node) continue;
    node.evaluation = clampMonotone(node.evaluation, u.evaluation);
    if (u.evaluatorNote && u.evaluatorNote.trim()) {
      node.evaluatorNote = u.evaluatorNote.trim();
    }
  }

  kg.lastEvaluatedAt = Date.now();
  kg.evaluationCount += 1;
  if (data.globalNote && data.globalNote.trim()) {
    kg.globalNote = data.globalNote.trim();
  }
  saveKG(kg);
}

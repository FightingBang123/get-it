/**
 * Concept-detection agent (one page at a time).
 *
 * Used by both the legacy `/api/analyze-pdf` route and the new
 * server-side jobs runner in lib/jobs.ts. Returns the typed
 * DetectionResult — caller is responsible for locating anchors and
 * persisting the result.
 */

import { runJson } from "../codex";
import {
  detectionBatchSchema,
  type DetectionBatchResult,
  type DetectionResult,
} from "../schemas";
import { systemPrompt } from "../../prompt/registry";
import type { MaterialKind } from "../../prompt/types";

/**
 * Detect concepts across a small batch of pages in ONE Codex call. Each page
 * is delimited by a PAGE_INDEX marker the agent echoes back per concept, so a
 * 5-page batch costs one call instead of five while keeping per-page quality
 * (the agent is told to judge each page independently). The constant SYSTEM
 * prefix is reused across batches → prompt-cache hit on every call after the
 * first.
 */
export async function detectConceptsForPages(
  pages: Array<{ pageIndex: number; text: string }>,
  signal?: AbortSignal,
  kind: MaterialKind = "default",
): Promise<DetectionBatchResult> {
  const body = pages
    .map((p) => `===== PAGE_INDEX ${p.pageIndex} =====\n${p.text}`)
    .join("\n\n");
  const prompt = `${systemPrompt("detect", kind)}\n\n--- PAGES ---\n${body}\n--- END PAGES ---`;
  const { data } = await runJson<DetectionBatchResult>(prompt, detectionBatchSchema, {
    reasoning: "low",
    signal,
  });
  return data;
}

/**
 * Single-page detection — thin wrapper over the batch path that strips the
 * `page` field, preserving the original DetectionResult shape for the legacy
 * /api/analyze-pdf route.
 */
export async function detectConceptsForPage(
  pageIndex: number,
  pageText: string,
  signal?: AbortSignal,
): Promise<DetectionResult> {
  const { concepts } = await detectConceptsForPages(
    [{ pageIndex, text: pageText }],
    signal,
    "default",
  );
  return {
    concepts: concepts.map(({ page: _page, ...rest }) => rest),
  };
}

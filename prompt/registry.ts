/**
 * Single entry point for agent system prompts.
 *
 * Call sites should ask the registry rather than importing individual tool
 * modules, so adding a new material kind or swapping a prompt is a one-file
 * change. The per-tool modules remain importable when a call site needs a
 * typed variant (e.g. feynman's turn count).
 */

import type { MaterialKind, PromptTool } from "./types";
import { chatSystem } from "./tools/chat";
import { flashcardsSystem } from "./tools/flashcards";
import { quizzesSystem } from "./tools/quizzes";
import { feynmanChildSystem, feynmanSummarySystem } from "./tools/feynman";
import { kgBuildSystem, kgMapSystem, kgReduceSystem } from "./tools/kg-build";
import { kgEvaluateSystem } from "./tools/kg-evaluate";
import { detectSystem } from "./tools/detect";

export type PromptOptions = {
  /** Feynman only: how many child prompts the session ran. */
  maxTurns?: number;
};

export function systemPrompt(
  tool: PromptTool,
  kind: MaterialKind = "default",
  opts: PromptOptions = {},
): string {
  switch (tool) {
    case "chat":
      return chatSystem(kind);
    case "flashcards":
      return flashcardsSystem(kind);
    case "quizzes":
      return quizzesSystem(kind);
    case "feynman-child":
      return feynmanChildSystem(kind);
    case "feynman-summary":
      return feynmanSummarySystem(opts.maxTurns ?? 4, kind);
    case "kg-build":
      return kgBuildSystem(kind);
    case "kg-map":
      return kgMapSystem(kind);
    case "kg-reduce":
      return kgReduceSystem(kind);
    case "kg-evaluate":
      return kgEvaluateSystem(kind);
    case "detect":
      return detectSystem(kind);
  }
}

export type { MaterialKind, PromptTool } from "./types";

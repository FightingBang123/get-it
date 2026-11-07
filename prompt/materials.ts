/**
 * Per-material guidance appended to every agent prompt.
 *
 * The base prompts describe the *job* (build a graph, write cards, …); this
 * paragraph describes the *material*, so the same job reads correctly whether
 * the source is a textbook, a novel, or a programming book. Add a new
 * MaterialKind here and every tool picks it up.
 */

import type { MaterialKind } from "./types";

const GUIDANCE: Record<MaterialKind, string> = {
  textbook: `MATERIAL TYPE: textbook.
Weight what is taught and later built upon — definitions, mechanisms,
formulas, worked exercises and the relationships between them. Keep units,
symbols and numeric relationships exact. Treat problem sets and examples as
first-class content, not decoration.`,

  novel: `MATERIAL TYPE: fiction.
The substance is characters, motivations, relationships, themes, symbols and
causal turns in the plot. Do not invent technical definitions or formulas.
Ground every point in a specific scene, line or chapter, and keep the work's
own voice and imagery intact.`,

  technical: `MATERIAL TYPE: technical / programming.
Prefer mechanisms, APIs, algorithms, invariants, trade-offs and failure modes.
Preserve identifiers, code, signatures, commands and precise terminology
exactly as written; never paraphrase code into prose. Examples of API usage
are content, not filler.`,

  default: "",
};

export function materialGuidance(kind: MaterialKind): string {
  return GUIDANCE[kind] ?? "";
}

/** Append the material guidance to a base system prompt. */
export function withMaterial(base: string, kind: MaterialKind = "default"): string {
  const guidance = materialGuidance(kind);
  return guidance ? `${base}\n\n${guidance}` : base;
}

/**
 * Prompt-layer types. Kept dependency-free so prompt modules stay pure
 * strings and can be imported from any runtime (route handlers, lib, tests).
 */

/**
 * What kind of source material a document is. Detected once at import
 * (lib/material-kind.ts) and stored on DocMeta; prompts use it to emphasise
 * the parts of the material that actually matter for that genre.
 */
export type MaterialKind = "textbook" | "novel" | "technical" | "default";

/** Every agent prompt that can vary by material kind. */
export type PromptTool =
  | "chat"
  | "flashcards"
  | "quizzes"
  | "feynman-child"
  | "feynman-summary"
  | "kg-build"
  | "kg-map"
  | "kg-reduce"
  | "kg-evaluate"
  | "detect";

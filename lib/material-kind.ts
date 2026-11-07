/**
 * Heuristic classification of a document's material kind.
 *
 * Runs once at import on the extracted text — no model call, no tokens. The
 * result is stored on DocMeta and used by the prompt registry to emphasise
 * what matters for that genre (definitions and formulas for a textbook,
 * characters and themes for a novel, APIs and algorithms for a technical
 * book).
 *
 * The thresholds below were calibrated on real documents (a Chinese novel and
 * a Chinese programming book); they are deliberately conservative — when the
 * signals are weak we fall back to "default", whose prompts behave exactly as
 * they did before material kinds existed.
 */

import type { MaterialKind } from "../prompt/types";

export type MaterialStats = {
  sampleChars: number;
  lines: number;
  codeLines: number;
  headingLines: number;
  dialogueChars: number;
  formulaChars: number;
};

/** Cap the sample so classification stays O(1) for a 400-page book. */
const MAX_SAMPLE_CHARS = 60_000;
/** Pages are sampled evenly so one chapter cannot dominate. */
const MAX_SAMPLE_PAGES = 40;

const CODE_LINE =
  /^\s*(?:#{1,6}\s|<!--|\/\*|\/\/|#\s*(?:include|define|import|pragma)|(?:def|class|function|fn|func|public|private|protected|static|final|import|from|const|let|var|return|if|for|while|switch|case|try|catch|package|using|namespace)\b.*[({:=;]|[^=]*[;{}]\s*$|<\/?[a-zA-Z][^>]*>)/;

const HEADING_LINE =
  /^\s*(?:第\s*[一二三四五六七八九十百千0-9]+\s*[章节篇部]|chapter\s+\d+|part\s+\d+|\d+(?:\.\d+){0,3}\s+\S|#{1,6}\s)/i;

// Curly quotes and CJK corner brackets are reliable dialogue markers; a
// straight apostrophe is not. Straight double quotes count too, but novels in
// Chinese/Japanese/Italian mostly use the first group.
const DIALOGUE_CHAR = /[“”「」『』„‟"]/g;
const FORMULA_CHAR = /[=+×÷≤≥≈∑∫√±∞π→⇒⇔≠±∓∂∇∈∉⊂⊆∪∩]/g;

function sampleText(pages: { text: string }[]): string {
  if (pages.length === 0) return "";
  const step = Math.max(1, Math.ceil(pages.length / MAX_SAMPLE_PAGES));
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < pages.length && total < MAX_SAMPLE_CHARS; i += step) {
    const text = pages[i].text;
    parts.push(text);
    total += text.length;
  }
  return parts.join("\n").slice(0, MAX_SAMPLE_CHARS);
}

export function analyseMaterial(pages: { text: string }[]): MaterialStats {
  const sample = sampleText(pages);
  const lines = sample.split("\n").filter((line) => line.trim().length > 0);
  let codeLines = 0;
  let headingLines = 0;
  for (const line of lines) {
    if (CODE_LINE.test(line)) codeLines++;
    if (HEADING_LINE.test(line)) headingLines++;
  }
  return {
    sampleChars: Math.max(1, sample.length),
    lines: Math.max(1, lines.length),
    codeLines,
    headingLines,
    dialogueChars: (sample.match(DIALOGUE_CHAR) ?? []).length,
    formulaChars: (sample.match(FORMULA_CHAR) ?? []).length,
  };
}

export function classifyMaterial(stats: MaterialStats): MaterialKind {
  const codeRatio = stats.codeLines / stats.lines;
  const dialogueRatio = stats.dialogueChars / stats.sampleChars;
  const formulaRatio = stats.formulaChars / stats.sampleChars;

  if (codeRatio >= 0.02 || stats.codeLines >= 40) return "technical";
  if (dialogueRatio >= 0.012 && codeRatio < 0.01) return "novel";
  if (stats.headingLines >= 8 || formulaRatio >= 0.004) return "textbook";
  return "default";
}

export function detectMaterialKind(pages: { text: string }[]): MaterialKind {
  return classifyMaterial(analyseMaterial(pages));
}

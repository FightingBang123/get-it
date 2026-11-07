/**
 * Token budgeting for model calls.
 *
 * Every prompt used to be "the whole document", bounded only by
 * MAX_PDF_PAGES. That works for a 20-page handout and falls apart for a
 * 350-page book: the provider either rejects the request or, worse, the CLI
 * silently runs auto-compaction and (in the bundled Pi) then fails with
 * "Cannot continue from message role: assistant".
 *
 * The rule from here on: a call is bounded by an estimated token budget, not
 * by how much text the document happens to contain. `estimateTokens` is a
 * heuristic — CJK text is close to one token per character, Latin script
 * closer to one per 3.5 — and deliberately conservative so we stay under the
 * provider's real tokenizer.
 */

const CJK_RE =
  /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/;
/** Code points outside the BMP (emoji, rare CJK) are still counted as one. */
const LATIN_TOKENS_PER_CHAR = 0.3;

/** Estimated tokens for a string. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += CJK_RE.test(ch) ? 1 : LATIN_TOKENS_PER_CHAR;
  }
  // The epsilon keeps exact boundaries (e.g. 1000 Latin chars = 300) from
  // flipping up a token because of binary floating-point error.
  return Math.ceil(tokens - 1e-9);
}

/**
 * Default chunk size for document text. Big enough to keep the model coherent
 * across a chapter or two, small enough that even a dense CJK page with
 * tooling instructions around it stays far below the context limit.
 */
export const DOC_CHUNK_TOKENS = 10_000;

/** A document that fits in a single call keeps the old one-shot behaviour. */
export const KG_SINGLE_CALL_TOKENS = 12_000;

/** How many map-phase calls may be in flight at once. */
export const MAP_CONCURRENCY = 2;

/** Return `true` when `text` fits inside `budget` tokens. */
export function fits(text: string, budget: number): boolean {
  return estimateTokens(text) <= budget;
}

/**
 * Take blocks in priority order until the budget is exhausted. Always keeps
 * the first block even when it alone exceeds the budget, so callers never get
 * an empty context for a pathological single item.
 */
export function takeWithinBudget<T extends { text: string }>(
  blocks: T[],
  budget: number,
  cost: (block: T) => number = (b) => estimateTokens(b.text),
): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const block of blocks) {
    const c = cost(block);
    if (kept.length > 0 && used + c > budget) break;
    kept.push(block);
    used += c;
  }
  return kept;
}

/** Run `fn` over `items` with at most `limit` promises in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

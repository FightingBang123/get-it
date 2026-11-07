/**
 * Server-side PDF text extraction using pdfjs-dist.
 *
 * Returns one record per page containing both the rendered viewport
 * dimensions (so the client can scale tag overlays) and the per-glyph-run
 * text items with their PDF-space positions.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Hard ceiling on document length. Beyond this the one-shot agent workflows
 * (knowledge-graph build, per-page detection, the study tools that feed the
 * model the whole document) would push context size, latency, and the user's
 * Codex usage window past what a desktop study session can absorb. We reject
 * up front with a clear message rather than degrade silently by sending only
 * fragments of the PDF to the model. Tunable — raise it as model context and
 * the batching pipeline allow.
 */
export const MAX_PDF_PAGES = 400;

/**
 * A page counts as "text-bearing" once it carries at least this many
 * alphanumeric characters (~25-30 words). Figure captions, page numbers and
 * stray glyphs fall below it; a real paragraph of prose clears it easily.
 */
const RICH_PAGE_ALNUM = 140;
/** Whole-document floor: under this the PDF has essentially no usable text. */
const MIN_TOTAL_ALNUM = 600;
/** Reject when fewer than this fraction of pages are text-bearing — i.e. the
 *  document is scanned / image-dominant and the text-only pipeline would lose
 *  too much of its meaning. */
const MIN_RICH_RATIO = 0.4;

export type PdfRejectReason =
  | "too_many_pages"
  | "no_text"
  | "image_dominant"
  | "unreadable";

export type PdfQualityStats = {
  numPages: number;
  textPages: number;
  totalAlnum: number;
  richRatio: number;
};

/** Thrown by extractPdf / assessPdfQuality for a PDF we refuse to ingest.
 *  The upload route maps `reason` to a user-facing alert. */
export class PdfUnsupportedError extends Error {
  readonly reason: PdfRejectReason;
  readonly stats?: PdfQualityStats;
  constructor(reason: PdfRejectReason, message: string, stats?: PdfQualityStats) {
    super(message);
    this.name = "PdfUnsupportedError";
    this.reason = reason;
    this.stats = stats;
  }
}

export type PdfTextItem = {
  /** The text run as PDF.js gave us. */
  str: string;
  /** Bottom-left x coordinate in PDF units (1/72 inch). */
  x: number;
  /** Bottom-left y coordinate in PDF units. */
  y: number;
  /** Run width in PDF units. */
  width: number;
  /** Glyph height in PDF units. */
  height: number;
  /** Whether this run carries a soft EOL break. */
  eol: boolean;
};

export type PdfPage = {
  pageIndex: number; // 0-based
  width: number; // PDF units
  height: number; // PDF units
  items: PdfTextItem[];
  /** Plain text for that page, items joined by their natural spacing. */
  text: string;
};

export type ExtractedPdf = {
  numPages: number;
  pages: PdfPage[];
};

export async function extractPdf(buffer: ArrayBuffer | Uint8Array): Promise<ExtractedPdf> {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const pdf = await getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    // We're already on Node (server-side). Don't try to spawn a Web
    // Worker — in the Next standalone build the worker .mjs is not
    // emitted alongside the main module, and pdfjs falls over with
    // "Setting up fake worker failed". Running in-process is fine for
    // our PDF sizes (textbook samples + user uploads up to ~20 MB).
    disableWorker: true,
  } as Parameters<typeof getDocument>[0]).promise;

  // Page-count gate — checked before we walk the pages so a 1000-page upload
  // is rejected cheaply instead of being fully extracted just to be refused.
  if (pdf.numPages > MAX_PDF_PAGES) {
    const total = pdf.numPages;
    pdf.destroy();
    throw new PdfUnsupportedError(
      "too_many_pages",
      `This PDF has ${total} pages. Get It. supports documents up to ${MAX_PDF_PAGES} pages.`,
      { numPages: total, textPages: 0, totalAlnum: 0, richRatio: 0 },
    );
  }

  const pages: PdfPage[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: PdfTextItem[] = [];
    const textParts: string[] = [];
    for (const it of tc.items as Array<Record<string, unknown>>) {
      const transform = it.transform as number[];
      // transform = [a, b, c, d, e, f] — scale_x, skew_y, skew_x, scale_y, e=x, f=y
      const x = transform[4];
      const y = transform[5];
      const width = (it.width as number) ?? 0;
      const height = (it.height as number) ?? Math.abs(transform[3]);
      const str = (it.str as string) ?? "";
      const eol = (it.hasEOL as boolean) ?? false;
      items.push({ str, x, y, width, height, eol });
      if (str) textParts.push(str);
      if (eol) textParts.push("\n");
      else if (str) textParts.push(" ");
    }
    pages.push({
      pageIndex: p - 1,
      width: viewport.width,
      height: viewport.height,
      items,
      text: textParts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n\n").trim(),
    });
    page.cleanup();
  }
  pdf.destroy();
  return { numPages: pdf.numPages, pages };
}

/** Count of alphanumeric (letters/digits, any script) characters — a
 *  language-agnostic proxy for "how much real text is on this page", immune
 *  to whitespace/punctuation padding that scanned-PDF text layers emit. */
function alnumCount(s: string): number {
  const m = s.match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/**
 * Decide whether an extracted PDF carries enough machine-readable text for
 * the text-only study pipeline to work well. Purely deterministic — no model
 * call, computed from the extraction we already ran.
 *
 * Rejects two failure modes:
 *   • "no_text"        — almost no extractable text at all (blank / pure image).
 *   • "image_dominant" — most pages have no text layer (scanned book, slide
 *                        deck that's all figures), so the concepts live in
 *                        pictures we don't read and the loss is too large.
 *
 * Accepts the common good case (a digital-native, well-tagged PDF with some
 * images scattered through prevalent text): such a doc clears both gates.
 */
export function assessPdfQuality(extracted: ExtractedPdf): {
  ok: boolean;
  reason: PdfRejectReason | "ok";
  stats: PdfQualityStats;
} {
  const numPages = extracted.numPages || extracted.pages.length;
  let textPages = 0;
  let totalAlnum = 0;
  for (const p of extracted.pages) {
    const n = alnumCount(p.text);
    totalAlnum += n;
    if (n >= RICH_PAGE_ALNUM) textPages++;
  }
  const richRatio = numPages > 0 ? textPages / numPages : 0;
  const stats: PdfQualityStats = { numPages, textPages, totalAlnum, richRatio };

  if (totalAlnum < MIN_TOTAL_ALNUM) {
    return { ok: false, reason: "no_text", stats };
  }
  if (richRatio < MIN_RICH_RATIO) {
    return { ok: false, reason: "image_dominant", stats };
  }
  return { ok: true, reason: "ok", stats };
}

/** Find the bounding box of `anchor` (substring of page.text) inside the
 *  per-item positions. Returns the bbox of the LAST occurrence so we can put a
 *  tag right after the matched span. Returns null if no match.
 *
 *  Strategy: walk forward through items concatenating their `str`, track each
 *  item's [start,end) offset in the concatenated text. Then find the substring
 *  position in the joined string and map back. We use the same join scheme as
 *  the page.text so offsets line up.
 */
export function locateAnchor(page: PdfPage, anchor: string): {
  endX: number;
  endY: number;
  fontHeight: number;
} | null {
  const parts: string[] = [];
  const itemRanges: Array<{ start: number; end: number; item: PdfTextItem }> = [];
  for (const item of page.items) {
    if (item.str) {
      const start = parts.join("").length;
      parts.push(item.str);
      const end = start + item.str.length;
      itemRanges.push({ start, end, item });
    }
    if (item.eol) parts.push("\n");
    else if (item.str) parts.push(" ");
  }
  const haystack = parts.join("");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const normHay = norm(haystack);
  const normNeedle = norm(anchor);
  const idx = normHay.lastIndexOf(normNeedle);
  if (idx < 0) return null;
  // Map normalized-index back to original-index (approximate).
  let nCount = 0;
  let origIdx = 0;
  for (; origIdx < haystack.length; origIdx++) {
    const ch = haystack[origIdx];
    if (/\s/.test(ch)) {
      if (origIdx > 0 && /\S/.test(haystack[origIdx - 1])) nCount++;
    } else {
      if (nCount === idx) break;
      nCount++;
    }
  }
  // Now find the item whose range contains origIdx + needle length.
  const target = Math.min(haystack.length - 1, origIdx + normNeedle.length);
  for (let i = itemRanges.length - 1; i >= 0; i--) {
    const r = itemRanges[i];
    if (target >= r.start && target <= r.end) {
      const it = r.item;
      // approximate "end of this run": x + width on the right, y at baseline
      return {
        endX: it.x + it.width,
        endY: it.y,
        fontHeight: it.height || 11,
      };
    }
  }
  // Fallback: use last item's end
  const last = itemRanges[itemRanges.length - 1];
  if (!last) return null;
  return {
    endX: last.item.x + last.item.width,
    endY: last.item.y,
    fontHeight: last.item.height || 11,
  };
}

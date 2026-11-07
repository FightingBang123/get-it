/**
 * Server-side Markdown → PDF rendering.
 *
 * Get It. is built around a PDF: the viewer renders the document page by
 * page and overlays concept tags at real PDF-space coordinates, and every
 * agent reads the per-page text that `lib/pdf-extract.ts` pulls out. To let
 * students study from a `.md` file without rebuilding any of that, we turn
 * the markdown into a clean, text-bearing PDF up front and then feed it
 * through the exact same `extractPdf` pipeline as a normal upload.
 *
 * We tokenize with `marked` (already a project dependency) and lay the
 * tokens out with `pdfkit` (the same library `scripts/generate-sample-pdfs.ts`
 * uses to mint the bundled sample documents), so this adds no new runtime
 * dependency.
 *
 * Scripts: the standard PDF fonts cover Latin. When the document contains
 * CJK (or kana / hangul / fullwidth) characters we register a system CJK
 * font and render the whole document with it — those fonts carry Latin
 * glyphs too, so mixed English/Chinese reads correctly. If no CJK font is
 * found on the host we fall back to the Latin fonts and Latin text still
 * renders; the text-coverage gate downstream will reject a doc that came out
 * blank, which is the right outcome on a system with no CJK font at all.
 */

import fs from "node:fs";
import PDFDocument from "pdfkit";
import { marked, type Token, type Tokens } from "marked";

/**
 * Reject absurdly large markdown before we spend time rendering it. The
 * extracted PDF still has to clear `MAX_PDF_PAGES`, but bailing on the raw
 * text first keeps a pathological paste from pinning a CPU. ~1M characters
 * is far longer than any real study document.
 */
export const MAX_MARKDOWN_BYTES = 1_000_000;

export class MarkdownEmptyError extends Error {
  constructor() {
    super("This Markdown file has no readable text.");
    this.name = "MarkdownEmptyError";
  }
}

export class MarkdownTooLargeError extends Error {
  constructor() {
    super("This Markdown file is too large to import.");
    this.name = "MarkdownTooLargeError";
  }
}

// ── Page geometry & palette ─────────────────────────────────────────────
// A4 in PDF points, with comfortable reading margins. Mirrors the editorial
// "ink on warm white" look of the bundled samples and the writeup PDF.

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 64;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const PAGE_BOTTOM = PAGE.height - MARGIN;

const INK_900 = "#0f172a";
const INK_700 = "#1e293b";
const INK_500 = "#64748b";
const ACCENT = "#4f5ae0";
const RULE = "#cbd5e1";
const CODE_BG = "#f3f2ef";

/** The four weights + monospace a document is drawn with. Swapped wholesale
 *  for a registered CJK family when the source contains CJK characters. */
type Fonts = {
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
  mono: string;
};

const LATIN_FONTS: Fonts = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  italic: "Helvetica-Oblique",
  boldItalic: "Helvetica-BoldOblique",
  mono: "Courier",
};

/** Matches CJK ideographs, kana, hangul, and CJK/fullwidth punctuation. */
export const CJK_RE =
  /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;

/** Tallest a figure may be drawn, in PDF points. Keeps one image from
 *  swallowing a whole page while still giving artwork room to breathe. */
const MAX_IMAGE_HEIGHT = 380;

/** Point size per heading depth (h1…h6). */
const HEADING_SIZE = [22, 17, 14, 12.5, 11.5, 11];
const BODY_SIZE = 11;
const CODE_SIZE = 9;
const LINE_GAP = 2.5;

type PDFKitDoc = InstanceType<typeof PDFDocument>;

/** Render context threaded through every block renderer. */
type Ctx = {
  doc: PDFKitDoc;
  fonts: Fonts;
  /** Resolves an image `src` from the Markdown to bytes, or null to fall back
   *  to the alt text. The EPUB importer uses this to pull pictures straight
   *  out of the archive. */
  resolveImage?: (src: string) => Buffer | null;
};

/** Inline run after emphasis/link nesting has been flattened to leaves. */
type Segment = {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  link?: string;
};

type Style = { bold: boolean; italic: boolean };

const BASE_STYLE: Style = { bold: false, italic: false };

// ── CJK font resolution ─────────────────────────────────────────────────

type CjkFace = { path: string; postscript?: string };
type CjkPair = { regular: CjkFace; bold: CjkFace };

/** Per-platform candidate CJK fonts, in preference order. `postscript` names
 *  a face inside a `.ttc` collection (omitted for single-face `.ttf`/`.otf`). */
function cjkCandidates(): CjkPair[] {
  switch (process.platform) {
    case "darwin":
      return [
        {
          regular: { path: "/System/Library/Fonts/PingFang.ttc", postscript: "PingFangSC-Regular" },
          bold: { path: "/System/Library/Fonts/PingFang.ttc", postscript: "PingFangSC-Semibold" },
        },
        {
          regular: { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscript: "HiraginoSansGB-W3" },
          bold: { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscript: "HiraginoSansGB-W6" },
        },
        {
          regular: { path: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf" },
          bold: { path: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf" },
        },
      ];
    case "win32":
      return [
        {
          regular: { path: "C:\\Windows\\Fonts\\msyh.ttc", postscript: "MicrosoftYaHei" },
          bold: { path: "C:\\Windows\\Fonts\\msyhbd.ttc", postscript: "MicrosoftYaHei-Bold" },
        },
        {
          regular: { path: "C:\\Windows\\Fonts\\simsun.ttc", postscript: "SimSun" },
          bold: { path: "C:\\Windows\\Fonts\\simsun.ttc", postscript: "SimSun" },
        },
        {
          regular: { path: "C:\\Windows\\Fonts\\malgun.ttf" },
          bold: { path: "C:\\Windows\\Fonts\\malgunbd.ttf" },
        },
      ];
    default:
      return [
        {
          regular: { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", postscript: "NotoSansCJKsc-Regular" },
          bold: { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", postscript: "NotoSansCJKsc-Bold" },
        },
        {
          regular: { path: "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf", postscript: "NotoSansCJKsc-Regular" },
          bold: { path: "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Bold.otf", postscript: "NotoSansCJKsc-Bold" },
        },
        {
          regular: { path: "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc" },
          bold: { path: "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc" },
        },
      ];
  }
}

/** First candidate whose regular face exists on disk, or null. */
function resolveCjkFont(): CjkPair | null {
  for (const c of cjkCandidates()) {
    if (fs.existsSync(c.regular.path)) {
      return { regular: c.regular, bold: fs.existsSync(c.bold.path) ? c.bold : c.regular };
    }
  }
  return null;
}

/**
 * If the markdown needs CJK and a system font is available, register it on
 * the document and return a CJK font map; otherwise return the Latin map.
 */
function setUpFonts(doc: PDFKitDoc, markdown: string): Fonts {
  if (!CJK_RE.test(markdown)) return LATIN_FONTS;
  const face = resolveCjkFont();
  if (!face) return LATIN_FONTS;
  try {
    doc.registerFont("cjk", face.regular.path, face.regular.postscript);
    doc.registerFont("cjk-bold", face.bold.path, face.bold.postscript);
  } catch {
    return LATIN_FONTS;
  }
  // CJK has no italic; reuse the upright faces. Code uses the CJK font too so
  // CJK inside code blocks still renders (at the cost of true monospacing).
  return { regular: "cjk", bold: "cjk-bold", italic: "cjk", boldItalic: "cjk-bold", mono: "cjk" };
}

// ── Inline flattening ───────────────────────────────────────────────────

/** Decode the handful of HTML entities `marked` leaves encoded in token text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Walk an inline token tree (the `tokens` array on a paragraph, heading,
 * list item, …) and flatten it to a flat list of styled leaf runs that
 * pdfkit can emit as one continued line.
 */
function flattenInline(tokens: Token[] | undefined, style: Style, out: Segment[]): void {
  if (!tokens) return;
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length) flattenInline(t.tokens, style, out);
        else out.push({ text: decodeEntities(t.text), bold: style.bold, italic: style.italic, mono: false });
        break;
      }
      case "escape": {
        const t = token as Tokens.Escape;
        out.push({ text: t.text, bold: style.bold, italic: style.italic, mono: false });
        break;
      }
      case "strong":
        flattenInline((token as Tokens.Strong).tokens, { ...style, bold: true }, out);
        break;
      case "em":
        flattenInline((token as Tokens.Em).tokens, { ...style, italic: true }, out);
        break;
      case "del":
        flattenInline((token as Tokens.Del).tokens, style, out);
        break;
      case "codespan": {
        const t = token as Tokens.Codespan;
        out.push({ text: decodeEntities(t.text), bold: style.bold, italic: style.italic, mono: true });
        break;
      }
      case "link": {
        const t = token as Tokens.Link;
        const before = out.length;
        flattenInline(t.tokens, style, out);
        for (let i = before; i < out.length; i++) out[i].link = t.href;
        break;
      }
      case "br":
        out.push({ text: "\n", bold: style.bold, italic: style.italic, mono: false });
        break;
      case "image": {
        // We can't lay out images with the standard pipeline; keep the alt
        // text so the document still reads and the detector has something.
        const t = token as Tokens.Image;
        if (t.text) out.push({ text: t.text, bold: style.bold, italic: style.italic, mono: false });
        break;
      }
      default: {
        const t = token as { text?: string };
        if (t.text) out.push({ text: decodeEntities(t.text), bold: style.bold, italic: style.italic, mono: false });
      }
    }
  }
}

function fontFor(seg: Segment, fonts: Fonts): string {
  if (seg.mono) return fonts.mono;
  if (seg.bold && seg.italic) return fonts.boldItalic;
  if (seg.bold) return fonts.bold;
  if (seg.italic) return fonts.italic;
  return fonts.regular;
}

type EmitOpts = {
  size: number;
  color: string;
  indent?: number;
  width?: number;
  paragraphGap?: number;
};

/** Emit a run of flattened segments as a single wrapped paragraph. */
function emitSegments(ctx: Ctx, segs: Segment[], opts: EmitOpts): void {
  const { doc, fonts } = ctx;
  const width = opts.width ?? CONTENT_WIDTH - (opts.indent ?? 0);
  if (segs.length === 0) {
    doc.text(" ", { width });
    return;
  }
  const last = segs.length - 1;
  segs.forEach((seg, i) => {
    doc
      .font(fontFor(seg, fonts))
      .fontSize(opts.size)
      .fillColor(seg.link ? ACCENT : opts.color);
    const textOpts: PDFKit.Mixins.TextOptions = {
      continued: i < last,
      width,
      lineGap: LINE_GAP,
    };
    if (i === last) textOpts.paragraphGap = opts.paragraphGap ?? 8;
    if (seg.link) {
      textOpts.link = seg.link;
      textOpts.underline = true;
    }
    doc.text(seg.text, textOpts);
  });
}

/** Add a page break before a block if it would otherwise be orphaned. */
function breakIfTight(doc: PDFKitDoc, needed: number): void {
  if (doc.y + needed > PAGE_BOTTOM) doc.addPage();
}

// ── Block renderers ─────────────────────────────────────────────────────

function renderHeading(ctx: Ctx, token: Tokens.Heading): void {
  const { doc } = ctx;
  const size = HEADING_SIZE[Math.min(token.depth, HEADING_SIZE.length) - 1];
  breakIfTight(doc, size * 2.4);
  doc.moveDown(token.depth <= 2 ? 0.6 : 0.4);
  const segs: Segment[] = [];
  flattenInline(token.tokens, BASE_STYLE, segs);
  // Headings render in a single weight regardless of inline emphasis.
  for (const s of segs) s.bold = true;
  emitSegments(ctx, segs, { size, color: INK_900, paragraphGap: 4 });
  doc.moveDown(0.25);
}

/** If a paragraph carries exactly one image and no other text, return it.
 *  That is how a standalone figure arrives after Markdown conversion. */
function soleImage(tokens: Token[] | undefined): Tokens.Image | null {
  if (!tokens) return null;
  let image: Tokens.Image | null = null;
  let textLength = 0;
  const walk = (list: Token[]) => {
    for (const token of list) {
      if (token.type === "image") {
        if (image) textLength += 1; // a second image disqualifies the block
        image = token as Tokens.Image;
      } else if ((token as Tokens.Text).tokens) {
        walk((token as Tokens.Text).tokens as Token[]);
      } else {
        textLength += ((token as { text?: string }).text ?? "").trim().length;
      }
    }
  };
  walk(tokens);
  return image && textLength === 0 ? image : null;
}

function renderImage(ctx: Ctx, src: string, alt: string): void {
  const { doc, fonts } = ctx;
  const bytes = ctx.resolveImage?.(src) ?? null;

  let width = 0;
  let height = 0;
  if (bytes) {
    try {
      const opened = (
        doc as unknown as {
          openImage(b: Buffer): { width: number; height: number };
        }
      ).openImage(bytes);
      width = opened.width;
      height = opened.height;
    } catch {
      width = 0;
    }
  }

  if (bytes && width > 0 && height > 0) {
    const scale = Math.min(CONTENT_WIDTH / width, MAX_IMAGE_HEIGHT / height, 1);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    breakIfTight(doc, drawHeight + 10);
    const x = MARGIN + (CONTENT_WIDTH - drawWidth) / 2;
    const y = doc.y;
    try {
      doc.image(bytes, x, y, { width: drawWidth, height: drawHeight });
      doc.x = MARGIN;
      doc.y = y + drawHeight;
      if (alt.trim()) {
        doc
          .font(fonts.italic)
          .fontSize(9)
          .fillColor(INK_500)
          .text(alt.trim(), MARGIN, doc.y + 4, {
            width: CONTENT_WIDTH,
            align: "center",
          });
      }
      doc.moveDown(0.6);
      return;
    } catch {
      doc.x = MARGIN;
      // fall through to the alt-text rendering below
    }
  }

  if (alt.trim()) {
    emitSegments(
      ctx,
      [{ text: alt.trim(), bold: false, italic: true, mono: false }],
      { size: BODY_SIZE, color: INK_500, paragraphGap: 8 },
    );
  }
}

function renderParagraph(ctx: Ctx, token: Tokens.Paragraph): void {
  const image = soleImage(token.tokens);
  if (image) {
    renderImage(ctx, image.href, image.text ?? "");
    return;
  }
  const segs: Segment[] = [];
  flattenInline(token.tokens, BASE_STYLE, segs);
  emitSegments(ctx, segs, { size: BODY_SIZE, color: INK_700, paragraphGap: 8 });
}

function renderList(ctx: Ctx, token: Tokens.List, depth = 0): void {
  const { doc, fonts } = ctx;
  const indent = 18 + depth * 16;
  let index = typeof token.start === "number" ? token.start : 1;
  for (const item of token.items) {
    const marker = token.ordered ? `${index}.` : "•";
    breakIfTight(doc, BODY_SIZE * 2);
    const markerX = MARGIN + indent - 14;
    const y = doc.y;
    doc.font(fonts.regular).fontSize(BODY_SIZE).fillColor(INK_500).text(marker, markerX, y, {
      width: 14,
      lineGap: LINE_GAP,
    });
    // Render the item's own inline content next to the marker, then recurse
    // into any nested blocks (sub-lists) underneath it.
    doc.x = MARGIN + indent;
    doc.y = y;
    const inline: Segment[] = [];
    const nested: Tokens.List[] = [];
    for (const child of item.tokens) {
      if (child.type === "list") nested.push(child as Tokens.List);
      else if (child.type === "text") flattenInline((child as Tokens.Text).tokens ?? [child as Token], BASE_STYLE, inline);
      else flattenInline([child], BASE_STYLE, inline);
    }
    emitSegments(ctx, inline, {
      size: BODY_SIZE,
      color: INK_700,
      indent,
      width: CONTENT_WIDTH - indent,
      paragraphGap: 3,
    });
    doc.x = MARGIN;
    for (const sub of nested) renderList(ctx, sub, depth + 1);
    index++;
  }
  doc.moveDown(0.3);
}

function renderCode(ctx: Ctx, token: Tokens.Code): void {
  const { doc, fonts } = ctx;
  const code = token.text.replace(/\n+$/, "");
  doc.font(fonts.mono).fontSize(CODE_SIZE);
  const innerWidth = CONTENT_WIDTH - 20;
  const height = doc.heightOfString(code, { width: innerWidth, lineGap: 2 });
  breakIfTight(doc, height + 16);
  const top = doc.y;
  doc
    .save()
    .rect(MARGIN, top, CONTENT_WIDTH, height + 14)
    .fill(CODE_BG)
    .restore();
  doc
    .font(fonts.mono)
    .fontSize(CODE_SIZE)
    .fillColor(INK_700)
    .text(code, MARGIN + 10, top + 7, { width: innerWidth, lineGap: 2 });
  doc.x = MARGIN;
  doc.y = top + height + 14;
  doc.moveDown(0.5);
}

function renderBlockquote(ctx: Ctx, token: Tokens.Blockquote): void {
  const { doc } = ctx;
  const top = doc.y;
  doc.x = MARGIN + 16;
  for (const child of token.tokens) renderBlock(ctx, child);
  const bottom = doc.y;
  doc
    .save()
    .lineWidth(2)
    .strokeColor(ACCENT)
    .moveTo(MARGIN + 4, top)
    .lineTo(MARGIN + 4, bottom)
    .stroke()
    .restore();
  doc.x = MARGIN;
  doc.moveDown(0.3);
}

function renderTable(ctx: Ctx, token: Tokens.Table): void {
  const { doc, fonts } = ctx;
  const cols = token.header.length;
  if (cols === 0) return;
  const colWidth = CONTENT_WIDTH / cols;
  const cellText = (cell: Tokens.TableCell): string => {
    const segs: Segment[] = [];
    flattenInline(cell.tokens, BASE_STYLE, segs);
    return segs.map((s) => s.text).join("");
  };
  const drawRow = (cells: Tokens.TableCell[], header: boolean): void => {
    const font = header ? fonts.bold : fonts.regular;
    const color = header ? INK_500 : INK_700;
    doc.font(font).fontSize(header ? 9 : 10);
    const heights = cells.map((c) =>
      doc.heightOfString(cellText(c), { width: colWidth - 12 }),
    );
    const rowHeight = Math.max(...heights, 14) + 8;
    breakIfTight(doc, rowHeight);
    const top = doc.y;
    cells.forEach((c, i) => {
      doc
        .font(font)
        .fontSize(header ? 9 : 10)
        .fillColor(color)
        .text(cellText(c), MARGIN + i * colWidth, top + 4, { width: colWidth - 12 });
    });
    doc.y = top + rowHeight;
    doc
      .save()
      .lineWidth(0.7)
      .strokeColor(RULE)
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + CONTENT_WIDTH, doc.y)
      .stroke()
      .restore();
  };
  doc.moveDown(0.3);
  drawRow(token.header, true);
  for (const row of token.rows) drawRow(row, false);
  doc.x = MARGIN;
  doc.moveDown(0.5);
}

function renderHr(doc: PDFKitDoc): void {
  doc.moveDown(0.4);
  doc
    .save()
    .lineWidth(0.7)
    .strokeColor(RULE)
    .moveTo(MARGIN, doc.y)
    .lineTo(MARGIN + CONTENT_WIDTH, doc.y)
    .stroke()
    .restore();
  doc.moveDown(0.5);
}

function renderBlock(ctx: Ctx, token: Token): void {
  switch (token.type) {
    case "heading":
      renderHeading(ctx, token as Tokens.Heading);
      break;
    case "paragraph":
      renderParagraph(ctx, token as Tokens.Paragraph);
      break;
    case "list":
      renderList(ctx, token as Tokens.List);
      break;
    case "code":
      renderCode(ctx, token as Tokens.Code);
      break;
    case "blockquote":
      renderBlockquote(ctx, token as Tokens.Blockquote);
      break;
    case "table":
      renderTable(ctx, token as Tokens.Table);
      break;
    case "hr":
      renderHr(ctx.doc);
      break;
    case "space":
      ctx.doc.moveDown(0.4);
      break;
    case "html":
      break; // raw HTML is dropped — we render text, not markup
    default: {
      // Anything else with text (e.g. a bare text block) still gets rendered.
      const t = token as { text?: string };
      if (t.text && t.text.trim()) {
        ctx.doc.font(ctx.fonts.regular).fontSize(BODY_SIZE).fillColor(INK_700).text(decodeEntities(t.text), {
          width: CONTENT_WIDTH,
          lineGap: LINE_GAP,
          paragraphGap: 8,
        });
      }
    }
  }
}

export type MarkdownPdfOptions = {
  /** Stamped into the PDF `Info` dictionary. */
  producer?: string;
  /**
   * Resolve an image reference to raw JPEG/PNG bytes. Returning null (or a
   * format pdfkit cannot draw, e.g. SVG) falls back to the alt text, so a
   * broken picture never fails the whole document.
   */
  resolveImage?: (src: string) => Buffer | null;
};

/**
 * Render a Markdown string to PDF bytes. The returned buffer is a normal,
 * text-bearing PDF that `extractPdf` reads exactly like any other upload.
 */
export async function markdownToPdf(
  markdown: string,
  opts: MarkdownPdfOptions = {},
): Promise<Buffer> {
  if (Buffer.byteLength(markdown, "utf-8") > MAX_MARKDOWN_BYTES) {
    throw new MarkdownTooLargeError();
  }
  if (!markdown.trim()) {
    throw new MarkdownEmptyError();
  }

  const tokens = marked.lexer(markdown, { gfm: true });

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Producer: opts.producer ?? "Get It. Markdown Importer" },
    bufferPages: true,
    pdfVersion: "1.7",
    lang: "en-US",
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const ctx: Ctx = {
    doc,
    fonts: setUpFonts(doc, markdown),
    resolveImage: opts.resolveImage,
  };

  doc.x = MARGIN;
  for (const token of tokens) renderBlock(ctx, token);

  doc.end();
  return done;
}

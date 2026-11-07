/**
 * XHTML (one EPUB spine document) → Markdown.
 *
 * We convert to Markdown rather than rendering straight to PDF because the
 * Markdown renderer (`lib/md-to-pdf.ts`) already owns font selection, CJK
 * fallback, headings, lists, tables, images and page layout. The converter's
 * job is to emit Markdown *only*: `marked` silently drops raw HTML blocks, so
 * any tag that leaks through would take its text with it.
 *
 * Two rules keep the output safe:
 *   • Whitespace inside text nodes is collapsed to single spaces, so book
 *     prose can never accidentally start a line with `#`, `-`, `>` or `|`
 *     and create a block.
 *   • Everything else Markdown could interpret inline is backslash escaped.
 */

import { tokenizeMarkup, type MarkupAttrs } from "./markup-scan";

export type XhtmlToMarkdownOptions = {
  /** Rewrite an `src`/`href` into something the caller can resolve later
   *  (e.g. an archive path). Return null to drop the reference. */
  resolveHref?: (src: string) => string | null;
};

const SKIP_TAGS = new Set([
  "head", "script", "style", "svg", "template", "noscript", "nav", "rt", "rp",
]);

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "aside",
  "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "dl", "dt", "dd",
]);

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const INLINE_MARKERS: Record<string, string> = {
  strong: "**",
  b: "**",
  em: "*",
  i: "*",
  del: "~~",
  s: "~~",
  strike: "~~",
};

function escapeInline(s: string): string {
  return s.replace(/([\\`*_[\]<>~])/g, "\\$1");
}

class Writer {
  private readonly out: string[] = [];
  private content = "";
  private quote = 0;

  setQuote(depth: number): void {
    this.quote = depth;
  }

  /** Append normalised, escaped prose to the current line. */
  text(raw: string): void {
    if (!raw) return;
    let t = raw.replace(/\s+/g, " ");
    if (!t.trim()) {
      if (this.content && !this.content.endsWith(" ")) this.content += " ";
      return;
    }
    t = escapeInline(t);
    if (!this.content) {
      this.content = t.replace(/^ /, "");
    } else if (this.content.endsWith(" ")) {
      this.content += t.replace(/^ /, "");
    } else {
      this.content += t;
    }
  }

  /** Append a Markdown marker (`**`, a backtick, `](href)`, …) verbatim. */
  marker(s: string): void {
    this.content += s;
  }

  /** Start a new line with a literal prefix (list bullet, …). */
  startLine(prefix = ""): void {
    this.endLine();
    this.content = prefix;
  }

  endLine(): void {
    const body = this.content.replace(/\s+$/, "");
    if (body.replace(/^>+ ?/, "").trim()) {
      this.out.push("> ".repeat(this.quote) + body);
    }
    this.content = "";
  }

  /** Finish the current block, leaving exactly one blank line. */
  paragraph(): void {
    this.endLine();
    if (this.out.length && this.out[this.out.length - 1] !== "") {
      this.out.push("");
    }
  }

  /** Emit pre-formatted lines verbatim (code fences, image marks, tables). */
  rawBlock(block: string): void {
    this.endLine();
    this.out.push(...block.split("\n"));
  }

  result(): string {
    this.endLine();
    return this.out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
}

function isExternal(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

function imageMarkdown(attrs: MarkupAttrs, src: string): string {
  const alt = (attrs.alt ?? "").replace(/\s+/g, " ").trim();
  const safe = encodeURI(src).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
  return `![${escapeInline(alt)}](${safe})`;
}

export function xhtmlToMarkdown(
  xhtml: string,
  opts: XhtmlToMarkdownOptions = {},
): string {
  const resolveHref = opts.resolveHref ?? ((src: string) => src);
  const events = tokenizeMarkup(xhtml);

  // Only render <body> when the document has one; otherwise the whole file.
  const hasBody = events.some((e) => e.kind === "open" && e.name === "body");

  const w = new Writer();
  let depth = 0;
  let bodyDepth: number | null = hasBody ? null : 0;
  let skipDepth = 0;
  let quoteDepth = 0;
  let pre: string[] | null = null;
  let codeDepth = 0;
  const listStack: { ordered: boolean; index: number }[] = [];
  const linkStack: (string | null)[] = [];

  let tableRows: string[][] | null = null;
  let tableRow: string[] | null = null;
  let tableCell: string | null = null;

  const inBody = () => bodyDepth !== null && depth > bodyDepth;
  const blockBreak = () => {
    if (listStack.length) w.endLine();
    else w.paragraph();
  };
  const listIndent = () => "  ".repeat(Math.max(0, listStack.length - 1));

  /** Route an inline marker to the table cell when one is open. */
  const mark = (s: string) => {
    if (tableCell !== null) tableCell += s;
    else w.marker(s);
  };

  for (const event of events) {
    if (event.kind === "open") {
      if (event.name === "body" && bodyDepth === null) bodyDepth = depth;

      if (skipDepth > 0) {
        if (!event.selfClosing && SKIP_TAGS.has(event.name)) skipDepth++;
        depth++;
        continue;
      }
      if (SKIP_TAGS.has(event.name)) {
        if (!event.selfClosing) skipDepth = 1;
        depth++;
        continue;
      }
      if (!inBody()) {
        depth++;
        continue;
      }

      const { name, attrs } = event;

      if (name === "br") {
        if (tableCell !== null) tableCell += " ";
        else w.endLine();
        depth++;
        continue;
      }
      if (name === "hr") {
        blockBreak();
        w.rawBlock("---");
        w.paragraph();
        depth++;
        continue;
      }
      if (HEADINGS.has(name)) {
        blockBreak();
        w.startLine("#".repeat(Number(name[1])) + " ");
        depth++;
        continue;
      }
      if (name === "img") {
        if (tableCell !== null) {
          // Images do not belong in a table cell; keep the alt text.
          if (attrs.alt) tableCell += attrs.alt;
        } else {
          const src = attrs.src ? resolveHref(attrs.src) : null;
          const alt = (attrs.alt ?? "").trim();
          if (src) {
            blockBreak();
            w.rawBlock(imageMarkdown(attrs, src));
            w.paragraph();
          } else if (alt) {
            w.text(alt);
          }
        }
        depth++;
        continue;
      }
      if (name === "pre") {
        blockBreak();
        pre = [];
        depth++;
        continue;
      }
      if (name === "code") {
        if (pre) codeDepth++;
        else mark("`");
        depth++;
        continue;
      }
      if (name === "blockquote") {
        blockBreak();
        quoteDepth++;
        w.setQuote(quoteDepth);
        depth++;
        continue;
      }
      if (name === "ul" || name === "ol") {
        blockBreak();
        listStack.push({
          ordered: name === "ol",
          index: Number(attrs.start ?? "1") || 1,
        });
        depth++;
        continue;
      }
      if (name === "li") {
        w.endLine();
        const list = listStack[listStack.length - 1];
        const bullet = list?.ordered ? `${list.index}. ` : "- ";
        if (list) list.index++;
        w.startLine(listIndent() + bullet);
        depth++;
        continue;
      }
      if (name === "table") {
        blockBreak();
        tableRows = [];
        depth++;
        continue;
      }
      if (name === "tr" && tableRows) {
        tableRow = [];
        depth++;
        continue;
      }
      if ((name === "td" || name === "th") && tableRow) {
        tableCell = "";
        depth++;
        continue;
      }
      if (name === "dl" || name === "dt" || name === "dd") {
        blockBreak();
        if (name === "dt") mark("**");
        depth++;
        continue;
      }
      if (name === "figcaption") {
        blockBreak();
        mark("*");
        depth++;
        continue;
      }
      if (INLINE_MARKERS[name]) {
        mark(INLINE_MARKERS[name]);
        depth++;
        continue;
      }
      if (name === "a") {
        const href = attrs.href ? resolveHref(attrs.href) : null;
        if (href && isExternal(href)) {
          linkStack.push(href);
          mark("[");
        } else {
          linkStack.push(null);
        }
        depth++;
        continue;
      }
      if (BLOCK_TAGS.has(name)) {
        blockBreak();
        depth++;
        continue;
      }

      depth++;
      continue;
    }

    if (event.kind === "close") {
      const insideBody = bodyDepth === null || depth > bodyDepth;
      depth--;

      if (skipDepth > 0) {
        if (SKIP_TAGS.has(event.name)) skipDepth--;
        continue;
      }
      if (!insideBody) continue;

      const name = event.name;

      // Specific closers first; BLOCK_TAGS deliberately comes last because it
      // overlaps table/figure/list tags.
      if (HEADINGS.has(name)) {
        w.paragraph();
        continue;
      }
      if (name === "li") {
        w.endLine();
        continue;
      }
      if (name === "ul" || name === "ol") {
        listStack.pop();
        if (!listStack.length) w.paragraph();
        else w.endLine();
        continue;
      }
      if (name === "blockquote") {
        w.paragraph();
        quoteDepth = Math.max(0, quoteDepth - 1);
        w.setQuote(quoteDepth);
        continue;
      }
      if (name === "pre") {
        const code = (pre ?? []).join("").replace(/^\n+|\n+$/g, "");
        pre = null;
        const longest = Math.max(
          0,
          ...(code.match(/`+/g) ?? []).map((run) => run.length),
        );
        const fence = "`".repeat(Math.max(3, longest + 1));
        w.rawBlock(`${fence}\n${code}\n${fence}`);
        w.paragraph();
        continue;
      }
      if (name === "code") {
        if (codeDepth > 0) codeDepth--;
        else mark("`");
        continue;
      }
      if (name === "table") {
        const rows = tableRows ?? [];
        tableRows = null;
        emitTable(w, rows);
        w.paragraph();
        continue;
      }
      if (name === "tr") {
        if (tableRows && tableRow) {
          tableRows.push(tableRow);
          tableRow = null;
        }
        continue;
      }
      if (name === "td" || name === "th") {
        if (tableRow) {
          tableRow.push((tableCell ?? "").replace(/\s+/g, " ").trim());
          tableCell = null;
        }
        continue;
      }
      if (name === "dl" || name === "dt" || name === "dd") {
        if (name === "dt") mark("**");
        blockBreak();
        continue;
      }
      if (name === "figcaption") {
        mark("*");
        w.paragraph();
        continue;
      }
      if (INLINE_MARKERS[name]) {
        mark(INLINE_MARKERS[name]);
        continue;
      }
      if (name === "a") {
        const href = linkStack.pop();
        if (href) mark(`](${href})`);
        continue;
      }
      if (BLOCK_TAGS.has(name)) {
        if (name === "p" && listStack.length) w.endLine();
        else blockBreak();
        continue;
      }

      continue;
    }

    // Text.
    if (skipDepth > 0) continue;
    if (bodyDepth !== null && depth <= bodyDepth) continue;

    if (pre) {
      pre.push(event.text);
      continue;
    }
    if (tableCell !== null) {
      tableCell += event.text;
      continue;
    }
    w.text(event.text);
  }

  return w.result();
}

function emitTable(w: Writer, rows: string[][]): void {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!rows.length || width === 0) return;
  const pad = (row: string[]) => {
    const cells = row.map((c) => c.replace(/\|/g, "\\|"));
    while (cells.length < width) cells.push("");
    return `| ${cells.join(" | ")} |`;
  };
  const [header, ...body] = rows;
  w.rawBlock(pad(header));
  w.rawBlock(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  for (const row of body) w.rawBlock(pad(row));
}

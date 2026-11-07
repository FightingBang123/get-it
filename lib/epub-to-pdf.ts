/**
 * EPUB → PDF conversion for the upload pipeline.
 *
 * An EPUB is a ZIP of XHTML chapters plus CSS and images. The rest of the
 * app is built around a PDF (page-indexed text, coordinate-anchored tags),
 * so — exactly like the Markdown importer — we convert up front and then
 * feed the result through the identical extract → quality-gate → store path.
 *
 * Pipeline:
 *   unzip → DRM check → META-INF/container.xml → OPF manifest/spine →
 *   each spine XHTML → Markdown (text, headings, lists, tables, images) →
 *   `markdownToPdf` (fonts, CJK, layout) → PDF bytes.
 *
 * Images are embedded when pdfkit can draw them (PNG/JPEG); SVG and broken
 * pictures fall back to their alt text, so one bad figure never kills the
 * import.
 *
 * Limits are enforced before the expensive render: the declared ZIP sizes
 * are checked at open, the assembled Markdown is page-estimated before
 * rendering, and long books are rejected with a message that tells the user
 * to import a part instead.
 */

import path from "node:path";
import { ZipReader, ZipFormatError, ZipLimitError } from "./zip-reader";
import { tokenizeMarkup } from "./markup-scan";
import {
  markdownToPdf,
  MarkdownEmptyError,
  MarkdownTooLargeError,
  CJK_RE,
} from "./md-to-pdf";
import { MAX_PDF_PAGES } from "./pdf-extract";
import { xhtmlToMarkdown } from "./xhtml-to-markdown";

export const MAX_EPUB_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const MAX_SPINE_ITEMS = 1_000;
const MAX_SPINE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGES = 200;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * Weighted characters (CJK counted double) that fill one A4 page at 11 pt.
 * Calibrated against real books: paragraph gaps and short dialogue lines
 * make a rendered page much sparser than a naive glyph count suggests —
 * ~1,500 weighted characters per page, not the ~3,200 a dense wall of text
 * would give.
 */
const EST_CHARS_PER_PAGE = 1_600;
/** A figure costs about half a page on average. */
const EST_PAGES_PER_IMAGE = 0.55;
/**
 * Only used to bail out on absurdly long books before spending a minute
 * rendering. The authoritative page check is `extractPdf`'s `MAX_PDF_PAGES`
 * gate, which runs on the real render — an estimate close to the cap is
 * deliberately allowed through so the exact count decides.
 */
const MAX_EST_PAGES = MAX_PDF_PAGES * 3;

export type EpubErrorCode =
  | "epub_drm"
  | "epub_too_large"
  | "epub_malformed"
  | "epub_empty"
  | "epub_too_long"
  | "epub_too_many_chapters";

export class EpubImportError extends Error {
  readonly code: EpubErrorCode;

  constructor(code: EpubErrorCode, message: string) {
    super(message);
    this.name = "EpubImportError";
    this.code = code;
  }
}

export class EpubDrmError extends EpubImportError {
  constructor() {
    super(
      "epub_drm",
      "This EPUB is protected by DRM or encryption. Get It. can't open protected books — try a DRM-free copy.",
    );
    this.name = "EpubDrmError";
  }
}

export class EpubTooLargeError extends EpubImportError {
  constructor() {
    super(
      "epub_too_large",
      "This EPUB file is too large to import. Get It. accepts EPUBs up to 20 MB — try a smaller edition or a single part.",
    );
    this.name = "EpubTooLargeError";
  }
}

export class EpubMalformedError extends EpubImportError {
  constructor(
    message = "This EPUB couldn't be read — it may be corrupted or not a real EPUB file. Try re-downloading it or opening it in a reader like Calibre first.",
  ) {
    super("epub_malformed", message);
    this.name = "EpubMalformedError";
  }
}

export class EpubEmptyError extends EpubImportError {
  constructor() {
    super(
      "epub_empty",
      "This EPUB has no readable text. Get It. reads text, not pictures — this may be a comic, a fixed-layout book, or an image-only EPUB.",
    );
    this.name = "EpubEmptyError";
  }
}

export class EpubTooLongError extends EpubImportError {
  constructor(estimatedPages: number) {
    super(
      "epub_too_long",
      `This book is roughly ${estimatedPages} pages long. Get It. supports documents up to ${MAX_PDF_PAGES} pages — try a single part or chapter.`,
    );
    this.name = "EpubTooLongError";
  }
}

export class EpubTooManyChaptersError extends EpubImportError {
  constructor() {
    super(
      "epub_too_many_chapters",
      "This EPUB has too many chapters to import. Try a single part of the book.",
    );
    this.name = "EpubTooManyChaptersError";
  }
}

/**
 * Estimate how many A4 pages the rendered book will occupy. Exported so the
 * test suite can calibrate `EST_CHARS_PER_PAGE` against the real renderer.
 */
export function estimatePdfPages(markdown: string, imageCount = 0): number {
  let units = 0;
  for (const ch of markdown) {
    if (ch === "\n") continue;
    units += CJK_RE.test(ch) ? 2 : 1;
  }
  return Math.ceil(units / EST_CHARS_PER_PAGE + imageCount * EST_PAGES_PER_IMAGE);
}

type SpineItem = { href: string };

/** Resolve a relative href against the package directory; reject escapes. */
function normalizeZipPath(href: string, baseDir = ""): string | null {
  const withoutFragment = href.split("#")[0].trim();
  if (!withoutFragment) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutFragment)) return null; // absolute URL
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    /* keep the raw form */
  }
  const joined = baseDir
    ? path.posix.join(baseDir, decoded)
    : decoded.replace(/\\/g, "/");
  const normalized = path.posix.normalize(joined);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized.replace(/^\.\//, "");
}

function mapZipError(err: unknown): EpubImportError {
  if (err instanceof ZipLimitError) return new EpubTooLargeError();
  if (err instanceof ZipFormatError) return new EpubMalformedError();
  return new EpubMalformedError();
}

const FONT_OBFUSCATION = new RegExp(
  "^http://(www\\.idpf\\.org/2008/embedding|ns\\.adobe\\.com/pdf/enc#RC)",
  "i",
);

/**
 * Many legitimate EPUBs carry `META-INF/encryption.xml` purely to obfuscate
 * embedded fonts. Only non-font algorithms (AES/DES/RC4) mean DRM.
 */
function assertNotDrm(zip: ZipReader): void {
  if (!zip.has("META-INF/encryption.xml")) return;
  let xml: string;
  try {
    xml = zip.readText("META-INF/encryption.xml");
  } catch {
    return;
  }
  const algorithms = [...xml.matchAll(/Algorithm\s*=\s*["']([^"']+)["']/gi)].map(
    (m) => m[1],
  );
  const drmAlgorithms = algorithms.filter((a) => !FONT_OBFUSCATION.test(a));
  if (drmAlgorithms.length > 0) throw new EpubDrmError();
  if (algorithms.length === 0 && /<(?:[\w-]+:)?EncryptedData\b/i.test(xml)) {
    throw new EpubDrmError();
  }
}

function findOpfPath(zip: ZipReader): string {
  if (zip.has("META-INF/container.xml")) {
    try {
      const xml = zip.readText("META-INF/container.xml");
      for (const event of tokenizeMarkup(xml)) {
        if (
          event.kind === "open" &&
          event.name === "rootfile" &&
          event.attrs["full-path"]
        ) {
          const candidate = normalizeZipPath(event.attrs["full-path"]);
          if (candidate && zip.has(candidate)) return candidate;
        }
      }
    } catch {
      /* fall through to the scan below */
    }
  }
  const opfs = zip
    .names()
    .filter((name) => name.toLowerCase().endsWith(".opf"))
    .sort((a, b) => a.length - b.length);
  if (opfs.length === 0) throw new EpubMalformedError();
  return opfs[0];
}

function readSpine(zip: ZipReader, opfPath: string): SpineItem[] {
  const xml = zip.readText(opfPath);
  const dir = path.posix.dirname(opfPath);
  const baseDir = dir === "." ? "" : dir;

  const manifest = new Map<
    string,
    { href: string; mediaType: string; properties: string }
  >();
  const itemrefs: { idref: string; linear: string }[] = [];

  for (const event of tokenizeMarkup(xml)) {
    if (event.kind !== "open") continue;
    if (event.name === "item" && event.attrs.id && event.attrs.href) {
      manifest.set(event.attrs.id, {
        href: event.attrs.href,
        mediaType: (event.attrs["media-type"] ?? "").toLowerCase(),
        properties: (event.attrs.properties ?? "").toLowerCase(),
      });
    } else if (event.name === "itemref" && event.attrs.idref) {
      itemrefs.push({
        idref: event.attrs.idref,
        linear: (event.attrs.linear ?? "").toLowerCase(),
      });
    }
  }

  const spine: SpineItem[] = [];
  for (const ref of itemrefs) {
    if (ref.linear === "no") continue;
    const item = manifest.get(ref.idref);
    if (!item) continue;
    if (item.properties.split(/\s+/).includes("nav")) continue;
    if (!/xhtml|html/.test(item.mediaType)) continue;
    const href = normalizeZipPath(item.href, baseDir);
    if (!href || !zip.has(href)) continue;
    spine.push({ href });
  }
  return spine;
}

function isDrawableImage(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return true; // PNG
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return true; // JPEG
  }
  return false;
}

export async function epubToPdf(epub: Buffer): Promise<Buffer> {
  if (epub.length > MAX_EPUB_BYTES) throw new EpubTooLargeError();

  let zip: ZipReader;
  try {
    zip = ZipReader.open(epub, {
      maxEntries: 5_000,
      maxEntryBytes: MAX_ENTRY_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
    });
  } catch (err) {
    throw mapZipError(err);
  }

  assertNotDrm(zip);

  let opfPath: string;
  let spine: SpineItem[];
  try {
    opfPath = findOpfPath(zip);
    spine = readSpine(zip, opfPath);
  } catch (err) {
    if (err instanceof EpubImportError) throw err;
    throw mapZipError(err);
  }

  if (spine.length > MAX_SPINE_ITEMS) throw new EpubTooManyChaptersError();
  if (spine.length === 0) {
    throw new EpubMalformedError(
      "This EPUB has no readable chapters — it may be corrupted or use a layout Get It. doesn't support.",
    );
  }

  let spineBytes = 0;
  const parts: string[] = [];

  for (const item of spine) {
    let raw: Buffer;
    try {
      raw = zip.read(item.href);
    } catch (err) {
      throw mapZipError(err);
    }
    spineBytes += raw.length;
    if (spineBytes > MAX_SPINE_BYTES) throw new EpubTooLargeError();

    const chapterDir = path.posix.dirname(item.href);
    const baseDir = chapterDir === "." ? "" : chapterDir;

    const markdown = xhtmlToMarkdown(raw.toString("utf8"), {
      resolveHref: (src) => {
        // External links survive so the renderer can emit a real link.
        if (/^https?:|^mailto:/i.test(src)) return src;
        if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null; // data:, file:, …
        return normalizeZipPath(src, baseDir);
      },
    });
    if (markdown.trim()) parts.push(markdown);
  }

  if (parts.length === 0) throw new EpubEmptyError();

  const markdown = parts.join("\n\n---\n\n");

  // A comic or fixed-layout book is nothing but pictures. Saying so here gives
  // the user an EPUB-worded message instead of the PDF "no selectable text"
  // rejection further down the pipeline.
  const proseOnly = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
  if (!proseOnly) throw new EpubEmptyError();

  const imageRefs = (markdown.match(/!\[[^\]]*\]\(/g) ?? []).length;
  const estimated = estimatePdfPages(markdown, imageRefs);
  if (estimated > MAX_EST_PAGES) throw new EpubTooLongError(estimated);

  let imageCount = 0;
  let imageBytes = 0;
  const imageCache = new Map<string, Buffer | null>();
  const resolveImage = (src: string): Buffer | null => {
    const cached = imageCache.get(src);
    if (cached !== undefined) return cached;

    if (imageCount >= MAX_IMAGES || !zip.has(src)) return null;
    let bytes: Buffer;
    try {
      bytes = zip.read(src);
    } catch {
      imageCache.set(src, null);
      return null;
    }
    if (
      bytes.length > MAX_IMAGE_BYTES ||
      imageBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES ||
      !isDrawableImage(bytes)
    ) {
      imageCache.set(src, null);
      return null;
    }
    imageCount++;
    imageBytes += bytes.length;
    imageCache.set(src, bytes);
    return bytes;
  };

  try {
    return await markdownToPdf(markdown, {
      producer: "Get It. EPUB Importer",
      resolveImage,
    });
  } catch (err) {
    if (err instanceof MarkdownEmptyError) throw new EpubEmptyError();
    if (err instanceof MarkdownTooLargeError) throw new EpubTooLargeError();
    throw err;
  }
}

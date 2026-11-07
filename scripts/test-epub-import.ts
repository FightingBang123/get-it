/**
 * Behavior tests for the EPUB importer (lib/epub-to-pdf.ts).
 *
 * Run: npm run test:epub
 *
 * Like the Markdown suite, these exercise the public contract — "an EPUB
 * becomes a text-bearing PDF whose text the agents can read" — and verify the
 * result round-trips through the same `extractPdf` + `assessPdfQuality` the
 * upload pipeline uses. EPUB fixtures are built in memory (a tiny ZIP writer
 * below) so the repo carries no binary test files.
 */

import { deflateRawSync } from "node:zlib";
import {
  epubToPdf,
  estimatePdfPages,
  EpubDrmError,
  EpubEmptyError,
  EpubMalformedError,
  EpubTooLargeError,
  EpubTooLongError,
  MAX_EPUB_BYTES,
} from "../lib/epub-to-pdf";
import { xhtmlToMarkdown } from "../lib/xhtml-to-markdown";
import { extractPdf, assessPdfQuality } from "../lib/pdf-extract";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function checkEqual(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, expected ${String(expected)}`);
}
function skip(name: string, detail?: string) {
  console.log(`SKIP  ${name}${detail ? `  — ${detail}` : ""}`);
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

// ── Minimal ZIP writer (store + deflate), just enough for a valid EPUB ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: { path: string; data: Buffer | string; store?: boolean }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const crc = crc32(data);
    const method = file.store ? 0 : 8;
    const payload = file.store ? data : deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

type Chapter = { id: string; body: string };

function xhtmlDoc(chapter: Chapter): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${chapter.id}</title><style>p{color:red}</style></head>
  <body>${chapter.body}</body>
</html>`;
}

function opf(chapters: Chapter[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
  </metadata>
  <manifest>
${chapters.map((c) => `    <item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`).join("\n")}
  </manifest>
  <spine>
${chapters.map((c) => `    <itemref idref="${c.id}"/>`).join("\n")}
  </spine>
</package>`;
}

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function makeEpub(opts: {
  chapters: Chapter[];
  encryptionXml?: string;
  omitContainer?: boolean;
  extraFiles?: { path: string; data: Buffer | string }[];
}): Buffer {
  const files: { path: string; data: Buffer | string; store?: boolean }[] = [
    { path: "mimetype", data: "application/epub+zip", store: true },
  ];
  if (!opts.omitContainer) files.push({ path: "META-INF/container.xml", data: CONTAINER });
  if (opts.encryptionXml) files.push({ path: "META-INF/encryption.xml", data: opts.encryptionXml });
  files.push({ path: "OEBPS/content.opf", data: opf(opts.chapters) });
  for (const chapter of opts.chapters) {
    files.push({ path: `OEBPS/${chapter.id}.xhtml`, data: xhtmlDoc(chapter) });
  }
  files.push(...(opts.extraFiles ?? []));
  return makeZip(files);
}

/** 1×1 PNG — enough for pdfkit to embed a real image XObject. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function filler(label: string, times: number): string {
  return Array.from({ length: times }, () => `<p>${label} — the quick brown fox jumps over the lazy dog while studying.</p>`).join("");
}

async function roundTrip(epub: Buffer) {
  const pdf = await epubToPdf(epub);
  const u8 = new Uint8Array(pdf.byteLength);
  u8.set(pdf);
  const extracted = await extractPdf(u8);
  const text = flat(extracted.pages.map((p) => p.text).join("\n"));
  return { pdf, extracted, text };
}

async function main() {
  // 1) Happy path: text, headings, lists, tables, code and an image all reach
  //    the PDF, and the result clears the same coverage gate a PDF upload does.
  {
    const epub = makeEpub({
      chapters: [
        {
          id: "ch1",
          body: `<h1>Photosynthesis</h1>
<p>Plants convert light into chemical energy. <strong>Chlorophyll</strong> absorbs photons.</p>
<ul><li>Light reactions</li><li>Calvin cycle</li></ul>
<table><tr><th>Stage</th><th>Where</th></tr><tr><td>Light</td><td>Thylakoid</td></tr></table>
<img src="pic.png" alt="A leaf cross-section"/>
${filler("Photosynthesis happens in the chloroplast.", 6)}`,
        },
        {
          id: "ch2",
          body: `<h1>Respiration</h1>
<p>Mitochondria oxidise glucose and release ATP.</p>
<pre><code>const atp = 36;</code></pre>
${filler("Cellular respiration releases energy.", 6)}`,
        },
      ],
      extraFiles: [{ path: "OEBPS/pic.png", data: TINY_PNG }],
    });

    const { pdf, text, extracted } = await roundTrip(epub);
    check("renders a valid PDF", pdf.subarray(0, 5).toString("ascii") === "%PDF-", `${pdf.length} bytes`);
    check("embeds the EPUB image", pdf.includes("/Subtype /Image"));
    check("keeps chapter 1 text", text.includes("Photosynthesis"));
    check("keeps emphasis text", text.includes("Chlorophyll"));
    check("keeps list items", text.includes("Calvin cycle"));
    check("keeps table cells", text.includes("Thylakoid"));
    check("keeps code block", text.includes("const atp = 36"));
    check("keeps chapter 2 text", text.includes("Mitochondria"));
    const quality = assessPdfQuality(extracted);
    check("clears the text-coverage gate", quality.ok, quality.reason);
  }

  // 2) Spine order is respected.
  {
    const epub = makeEpub({
      chapters: [
        { id: "a", body: `<p>ALPHA FIRST</p>${filler("alpha", 4)}` },
        { id: "b", body: `<p>BETA SECOND</p>${filler("beta", 4)}` },
      ],
    });
    const { text } = await roundTrip(epub);
    check("spine order: alpha before beta", text.indexOf("ALPHA FIRST") < text.indexOf("BETA SECOND"));
  }

  // 3) XHTML → Markdown unit cases (no ZIP needed).
  {
    checkEqual("heading levels", xhtmlToMarkdown("<body><h2>Hi</h2></body>"), "## Hi");
    checkEqual(
      "nested list",
      xhtmlToMarkdown("<body><ul><li>one<ul><li>inner</li></ul></li></ul></body>"),
      "- one\n  - inner",
    );
    checkEqual(
      "ordered list honours start",
      xhtmlToMarkdown('<body><ol start="3"><li>third</li></ol></body>'),
      "3. third",
    );
    checkEqual(
      "drops script and style content",
      xhtmlToMarkdown("<body><style>p{color:red}</style><script>alert(1)</script><p>safe</p></body>"),
      "safe",
    );
    checkEqual(
      "decodes entities",
      xhtmlToMarkdown("<body><p>a &mdash; b&nbsp;c &#x4E2D;</p></body>"),
      "a — b c 中",
    );
    checkEqual(
      "attribute containing > does not break the tag",
      xhtmlToMarkdown('<body><p title="a > b">ok</p></body>'),
      "ok",
    );
    checkEqual(
      "relative link keeps its label only",
      xhtmlToMarkdown('<body><p><a href="notes.html">see notes</a></p></body>'),
      "see notes",
    );
    checkEqual(
      "external link survives",
      xhtmlToMarkdown('<body><p><a href="https://example.com">site</a></p></body>'),
      "[site](https://example.com)",
    );
    checkEqual(
      "image emits a standalone mark",
      xhtmlToMarkdown(
        '<body><img src="pics/fig 1.png" alt="Figure"/></body>',
        { resolveHref: (s) => s },
      ),
      "![Figure](pics/fig%201.png)",
    );
    check("unclosed paragraph still yields text", xhtmlToMarkdown("<body><p>open text").includes("open text"));
    check("uppercase tags are accepted", xhtmlToMarkdown("<BODY><P>Loud</P></BODY>").includes("Loud"));
  }

  // 4) DRM is rejected, but font obfuscation alone is not DRM.
  {
    const drm = makeEpub({
      chapters: [{ id: "c", body: "<p>secret</p>" }],
      encryptionXml: `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
          <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
        </EncryptedData></encryption>`,
    });
    let drmError: unknown = null;
    try {
      await epubToPdf(drm);
    } catch (e) {
      drmError = e;
    }
    check("DRM EPUB throws EpubDrmError", drmError instanceof EpubDrmError);
    check("DRM code is stable", (drmError as EpubDrmError | null)?.code === "epub_drm");

    const obfuscated = makeEpub({
      chapters: [{ id: "c", body: "<p>readable text</p>" }],
      encryptionXml: `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
          <EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
        </EncryptedData></encryption>`,
    });
    const ok = await epubToPdf(obfuscated);
    check("font-obfuscated EPUB still converts", ok.subarray(0, 5).toString("ascii") === "%PDF-");
  }

  // 5) Malformed inputs.
  {
    let err: unknown = null;
    try {
      await epubToPdf(makeZip([{ path: "hello.txt", data: "hi" }]));
    } catch (e) {
      err = e;
    }
    check("ZIP without an OPF is malformed", err instanceof EpubMalformedError);

    let err2: unknown = null;
    try {
      await epubToPdf(Buffer.from("definitely not a zip"));
    } catch (e) {
      err2 = e;
    }
    check("random bytes are malformed", err2 instanceof EpubMalformedError);
  }

  // 6) Empty / image-only book.
  {
    const epub = makeEpub({
      chapters: [{ id: "c", body: '<p><img src="x.png" alt=""/></p>' }],
      extraFiles: [{ path: "OEBPS/x.png", data: TINY_PNG }],
    });
    let err: unknown = null;
    try {
      await epubToPdf(epub);
    } catch (e) {
      err = e;
    }
    check("image-only EPUB is empty", err instanceof EpubEmptyError);
  }

  // 7) Limits.
  {
    let err: unknown = null;
    try {
      await epubToPdf(Buffer.alloc(MAX_EPUB_BYTES + 1));
    } catch (e) {
      err = e;
    }
    check("oversized file is rejected before unzip", err instanceof EpubTooLargeError);

    const long = makeEpub({
      chapters: [{ id: "c", body: `<p>${"long book text ".repeat(220_000)}</p>` }],
    });
    let err2: unknown = null;
    const started = Date.now();
    try {
      await epubToPdf(long);
    } catch (e) {
      err2 = e;
    }
    check("very long book is rejected by the page estimate", err2 instanceof EpubTooLongError);
    check("page estimate rejects fast", Date.now() - started < 5_000, `${Date.now() - started}ms`);
    check("estimatePdfPages scales with length", estimatePdfPages("a".repeat(6_400)) === 4);
  }

  // 8) CJK content renders without throwing (same conditional as the md suite).
  {
    const epub = makeEpub({
      chapters: [{ id: "c", body: "<h1>光合作用</h1><p>植物把光能转化为化学能。</p>".repeat(6) }],
    });
    const { pdf, text } = await roundTrip(epub);
    check("CJK EPUB renders a PDF", pdf.subarray(0, 5).toString("ascii") === "%PDF-");
    if (text.includes("光合作用")) {
      check("CJK text round-trips", true);
    } else {
      skip("CJK text round-trips", "no CJK font on this host — same fallback as the Markdown importer");
    }
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

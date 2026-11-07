/**
 * POST /api/upload
 *   multipart/form-data:
 *     - file: <PDF blob>      (when uploading from the user's machine)
 *     - sample: <name>        (when picking one of /public/pdfs/<name>.pdf)
 *
 * Returns: { docId, numPages, pages: [{ pageIndex, width, height, text }], pdfUrl }
 *
 * Sample idempotency: clicking the same sample twice returns the same
 * docId so the user's KG / chats / flashcards / quizzes / feynman sessions
 * survive a back-and-forth.
 * Real uploads always mint a new docId — students who genuinely re-upload
 * the same file get a new entry and can delete duplicates from Library.
 */

import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  extractPdf,
  assessPdfQuality,
  PdfUnsupportedError,
  MAX_PDF_PAGES,
  type ExtractedPdf,
  type PdfRejectReason,
  type PdfQualityStats,
} from "@/lib/pdf-extract";
import {
  markdownToPdf,
  MarkdownEmptyError,
  MarkdownTooLargeError,
} from "@/lib/md-to-pdf";
import { epubToPdf, EpubImportError } from "@/lib/epub-to-pdf";
import { ensureDocDir, pdfPath } from "@/lib/paths";
import { getDoc, newDocId, saveDoc } from "@/lib/store";
import { detectMaterialKind } from "@/lib/material-kind";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Extensions we accept as Markdown and render to PDF before ingesting. */
const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mdwn)$/i;

/** EPUB books are unzipped, converted to Markdown and rendered to PDF. */
const EPUB_EXT = /\.epub$/i;

const SAMPLE_NAME_TO_DOC_ID: Record<string, string> = {
  anatomy: "sample-anatomy",
  physics: "sample-physics",
  costituzione: "sample-costituzione",
  calculus: "sample-calculus",
  chemistry: "sample-chemistry",
};

/** User-facing copy for every rejection reason. Coherent voice across the
 *  whole gate so the UploadCard alert reads the same regardless of cause. */
function rejectionMessage(reason: PdfRejectReason, stats?: PdfQualityStats): string {
  switch (reason) {
    case "too_many_pages":
      return `This document has ${stats?.numPages ?? "too many"} pages. Get It. supports documents up to ${MAX_PDF_PAGES} pages — try a single chapter or a shorter export.`;
    case "no_text":
      return "This PDF has almost no selectable text. Get It. reads the text layer of a document, not pictures of pages — this looks like a scan or an image-only export. Try a digital, text-based PDF (one where you can select the text in a reader).";
    case "image_dominant":
      return `This looks like a scanned or image-heavy PDF — only ${stats?.textPages ?? 0} of ${stats?.numPages ?? 0} pages have a usable text layer. Get It. reads text, not images, so too much of this document would be lost. Try a digital, text-based PDF.`;
    case "unreadable":
    default:
      return "This PDF couldn't be read — it may be encrypted, password-protected, or corrupted. Try re-exporting it or removing protection, then upload again.";
  }
}

function rejectResponse(reason: PdfRejectReason, stats?: PdfQualityStats) {
  return NextResponse.json(
    { error: rejectionMessage(reason, stats), code: reason, stats },
    { status: 422 },
  );
}

export async function POST(req: Request) {
  let buffer: Buffer;
  let filename = "uploaded.pdf";
  let presetDocId: string | null = null;

  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const sample = form.get("sample");
    if (typeof sample === "string" && sample) {
      const safe = sample.replace(/[^a-z0-9-]/gi, "");
      const sampleDocId = SAMPLE_NAME_TO_DOC_ID[safe];
      if (!sampleDocId) {
        return NextResponse.json({ error: "unknown sample" }, { status: 400 });
      }
      // Already in the library? Reuse it.
      const existing = getDoc(sampleDocId);
      if (existing) {
        return NextResponse.json({
          docId: existing.id,
          filename: existing.filename,
          pdfUrl: existing.pdfUrl,
          numPages: existing.extracted.numPages,
          pages: existing.extracted.pages.map((p) => ({
            pageIndex: p.pageIndex,
            width: p.width,
            height: p.height,
            text: p.text,
          })),
        });
      }
      const p = path.join(process.cwd(), "public", "pdfs", `${safe}.pdf`);
      buffer = await fs.readFile(p);
      filename = `${safe}.pdf`;
      presetDocId = sampleDocId;
    } else {
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: "no file" }, { status: 400 });
      }
      buffer = Buffer.from(await file.arrayBuffer());
      const fname = (file as unknown as { name?: string }).name;
      if (fname) filename = fname.replace(/[^a-z0-9._-]/gi, "_");

      // Markdown uploads: render to a clean, text-bearing PDF up front, then
      // fall through to the exact same extract → gate → store pipeline as any
      // other PDF. The %PDF- sanity check below then validates the rendered
      // bytes (pdfkit emits a 1.7 header).
      if (MARKDOWN_EXT.test(filename)) {
        try {
          buffer = await markdownToPdf(buffer.toString("utf-8"));
        } catch (e) {
          if (e instanceof MarkdownEmptyError || e instanceof MarkdownTooLargeError) {
            return NextResponse.json({ error: e.message }, { status: 422 });
          }
          return NextResponse.json(
            { error: "This Markdown file couldn't be converted to a document." },
            { status: 422 },
          );
        }
      }

      // EPUB uploads: unzip, walk the spine, render text + figures to PDF, then
      // fall through to the exact same pipeline as any other upload. Every
      // failure below is a 422 with user-facing copy from the converter.
      if (EPUB_EXT.test(filename)) {
        try {
          buffer = await epubToPdf(buffer);
        } catch (e) {
          if (e instanceof EpubImportError) {
            return NextResponse.json({ error: e.message, code: e.code }, { status: 422 });
          }
          return NextResponse.json(
            { error: "This EPUB file couldn't be converted to a document." },
            { status: 422 },
          );
        }
      }
    }
  } else {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  // Sanity: must look like a PDF.
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    return NextResponse.json({ error: "not a PDF" }, { status: 400 });
  }

  // Extract FIRST, from the in-memory bytes, so we can gate the document
  // before writing anything to disk or kicking off any agent workflow. A
  // rejected upload leaves no orphan files behind.
  //
  // pdf.js refuses Buffer instances; copy to a plain Uint8Array.
  const u8 = new Uint8Array(buffer.byteLength);
  u8.set(buffer);
  let extracted: ExtractedPdf;
  try {
    extracted = await extractPdf(u8);
  } catch (e) {
    if (e instanceof PdfUnsupportedError) {
      return rejectResponse(e.reason, e.stats);
    }
    // pdf.js throws on encrypted / corrupt files — surface a friendly hint
    // instead of a 500.
    return rejectResponse("unreadable");
  }

  // Text-coverage gate. Samples are curated and known-good, so they skip it;
  // real uploads must carry enough machine-readable text to study from.
  if (!presetDocId) {
    const quality = assessPdfQuality(extracted);
    if (!quality.ok) {
      return rejectResponse(quality.reason as PdfRejectReason, quality.stats);
    }
  }

  const docId = presetDocId ?? newDocId();
  ensureDocDir(docId);
  await fs.writeFile(pdfPath(docId), buffer);
  const pdfUrl = `/api/pdf/${docId}`;

  saveDoc({
    id: docId,
    filename,
    uploadedAt: Date.now(),
    numPages: extracted.numPages,
    // Empty, cheap, and stored with the doc so every later prompt can be
    // tailored to the genre without re-analysing the text.
    materialKind: detectMaterialKind(extracted.pages),
    extracted,
    pdfUrl,
  });

  return NextResponse.json({
    docId,
    filename,
    pdfUrl,
    numPages: extracted.numPages,
    pages: extracted.pages.map((p) => ({
      pageIndex: p.pageIndex,
      width: p.width,
      height: p.height,
      text: p.text,
    })),
  });
}

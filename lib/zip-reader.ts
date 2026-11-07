/**
 * Minimal, dependency-free ZIP reader for EPUB containers.
 *
 * An EPUB is just a ZIP: `mimetype`, `META-INF/container.xml`, an OPF
 * package document, and one XHTML file per chapter. The only compression
 * methods real-world EPUBs use are "stored" and "deflate", both of which
 * `node:zlib` already covers, so we parse the central directory ourselves
 * instead of pulling a new runtime dependency into the desktop bundle.
 *
 * Deliberate limitations:
 *   • ZIP64 is rejected (an EPUB over 4 GB is not a book).
 *   • CRC32 is not verified — a corrupt entry surfaces as malformed XML
 *     downstream, which is the same user-visible outcome.
 *   • Only stored (0) and deflate (8) are supported; anything else is a
 *     malformed archive.
 *
 * Limits are enforced from the *declared* sizes in the central directory,
 * before decompressing anything, so a zip bomb is rejected cheaply.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export type ZipLimits = {
  /** Maximum number of entries in the archive. */
  maxEntries: number;
  /** Maximum declared uncompressed size of a single entry. */
  maxEntryBytes: number;
  /** Maximum declared uncompressed size across all entries. */
  maxTotalBytes: number;
};

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

type Entry = {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

/** Normalize separators and reject entries that would escape the archive. */
function normalizeEntryName(raw: string): string {
  let name = raw.replace(/\\/g, "/");
  while (name.startsWith("./")) name = name.slice(2);
  name = name.replace(/^\/+/, "");
  if (name.split("/").includes("..")) {
    throw new ZipFormatError("unsafe entry path");
  }
  return name;
}

export class ZipReader {
  private readonly byName = new Map<string, Entry>();
  private readonly byLowerName = new Map<string, Entry>();

  private constructor(
    private readonly buffer: Buffer,
    entries: Entry[],
  ) {
    for (const entry of entries) {
      this.byName.set(entry.name, entry);
      const lower = entry.name.toLowerCase();
      if (!this.byLowerName.has(lower)) this.byLowerName.set(lower, entry);
    }
  }

  static open(buffer: Buffer, limits: ZipLimits): ZipReader {
    const eocd = findEndOfCentralDirectory(buffer);

    const entryCount = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    const centralOffset = buffer.readUInt32LE(eocd + 16);

    if (
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw new ZipFormatError("ZIP64 archives are not supported");
    }
    if (centralOffset + centralSize > buffer.length) {
      throw new ZipFormatError("central directory is out of bounds");
    }
    if (entryCount > limits.maxEntries) {
      throw new ZipLimitError(`archive declares ${entryCount} entries`);
    }

    const entries: Entry[] = [];
    let p = centralOffset;
    let declaredTotal = 0;

    for (let i = 0; i < entryCount; i++) {
      if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIG) {
        throw new ZipFormatError("bad central directory record");
      }
      const flags = buffer.readUInt16LE(p + 8);
      const method = buffer.readUInt16LE(p + 10);
      const compressedSize = buffer.readUInt32LE(p + 20);
      const uncompressedSize = buffer.readUInt32LE(p + 24);
      const nameLen = buffer.readUInt16LE(p + 28);
      const extraLen = buffer.readUInt16LE(p + 30);
      const commentLen = buffer.readUInt16LE(p + 32);
      const localHeaderOffset = buffer.readUInt32LE(p + 42);

      if (p + 46 + nameLen > buffer.length) {
        throw new ZipFormatError("truncated central directory");
      }
      if (method !== 0 && method !== 8) {
        throw new ZipFormatError(`unsupported compression method ${method}`);
      }
      if (uncompressedSize > limits.maxEntryBytes) {
        throw new ZipLimitError("entry exceeds the per-file size limit");
      }
      declaredTotal += uncompressedSize;
      if (declaredTotal > limits.maxTotalBytes) {
        throw new ZipLimitError("archive exceeds the total size limit");
      }

      const name = normalizeEntryName(
        buffer.toString("utf8", p + 46, p + 46 + nameLen),
      );
      // Directory markers are harmless but not readable.
      if (name && !name.endsWith("/")) {
        entries.push({
          name,
          flags,
          method,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
        });
      }

      p += 46 + nameLen + extraLen + commentLen;
    }

    return new ZipReader(buffer, entries);
  }

  /** Every readable entry name, in central-directory order. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /** Exact match first, then a case-insensitive fallback: OPF hrefs are
   *  frequently spelled with different casing than the ZIP entries. */
  has(name: string): boolean {
    return this.byName.has(name) || this.byLowerName.has(name.toLowerCase());
  }

  read(name: string): Buffer {
    const entry =
      this.byName.get(name) ?? this.byLowerName.get(name.toLowerCase());
    if (!entry) throw new ZipFormatError(`missing entry: ${name}`);
    if ((entry.flags & 0x1) !== 0) {
      throw new ZipFormatError(`encrypted entry: ${entry.name}`);
    }

    const p = entry.localHeaderOffset;
    if (p + 30 > this.buffer.length || this.buffer.readUInt32LE(p) !== LOCAL_SIG) {
      throw new ZipFormatError(`bad local header for ${entry.name}`);
    }
    const nameLen = this.buffer.readUInt16LE(p + 26);
    const extraLen = this.buffer.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extraLen;
    const end = start + entry.compressedSize;
    if (end > this.buffer.length) {
      throw new ZipFormatError(`truncated data for ${entry.name}`);
    }

    const raw = this.buffer.subarray(start, end);
    if (entry.method === 0) return Buffer.from(raw);

    try {
      return inflateRawSync(raw, {
        maxOutputLength: Math.max(entry.uncompressedSize, 1),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new ZipLimitError(`entry expands beyond its declared size: ${entry.name}`);
      }
      throw new ZipFormatError(`could not inflate ${entry.name}`);
    }
  }

  /** Read a text entry, honouring a UTF-8 or UTF-16 byte-order mark. */
  readText(name: string): string {
    const buf = this.read(name);
    if (buf.length >= 2) {
      if (buf[0] === 0xfe && buf[1] === 0xff) {
        return swapUtf16(buf.subarray(2), true);
      }
      if (buf[0] === 0xff && buf[1] === 0xfe) {
        return swapUtf16(buf.subarray(2), false);
      }
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return buf.toString("utf8", 3);
    }
    return buf.toString("utf8");
  }
}

function swapUtf16(buf: Buffer, bigEndian: boolean): string {
  const even = buf.length - (buf.length % 2);
  const copy = Buffer.from(buf.subarray(0, even));
  if (bigEndian) copy.swap16();
  return copy.toString("utf16le");
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < 22) throw new ZipFormatError("not a ZIP archive");
  const stop = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipFormatError("not a ZIP archive");
}

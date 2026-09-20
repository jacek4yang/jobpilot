/**
 * Minimal ZIP writer.
 *
 * Why hand-rolled rather than a library: the requirement is a handful of small
 * text files bundled into one downloadable file. A general-purpose archive
 * library would add tens of kilobytes to a userscript that runs on every BOSS
 * page load, for a feature used only during testing. CRC-32 plus a local and
 * central directory header is a small, fully testable function.
 *
 * Format notes:
 *  - **Store only (no compression).** Diagnostics are mostly NDJSON that is
 *    already going to be read by a tool, and store-only keeps CPU negligible so
 *    bundling cannot perturb the timing of a live test. Compression can be
 *    added later without changing the reader, since the method is recorded.
 *  - **No ZIP64.** File sizes are bounded by the ring-buffer capacities, far
 *    below the 4 GiB limit. `MAX_ENTRY_BYTES` guards the invariant rather than
 *    silently producing a corrupt archive.
 *  - **Deterministic timestamps.** Entries use the session start time, so two
 *    bundles from the same scenario differ only where the content differs.
 */

/** ZIP64 becomes necessary above this; diagnostics never approach it. */
const MAX_ENTRY_BYTES = 0xffffffff;
const MAX_TOTAL_BYTES = 0xfffffffe;

/** DOS epoch. Used when a timestamp predates 1980. */
const DOS_EPOCH_YEAR = 1980;

export interface ZipEntry {
  /** Forward-slash separated path inside the archive. */
  readonly path: string;
  readonly content: string;
  /** Entry modification time, in epoch milliseconds. */
  readonly modifiedAt: number;
}

// --- CRC-32 -----------------------------------------------------------------

/**
 * Standard CRC-32 (IEEE 802.3) lookup table.
 *
 * Built once at module load; the table is 1 KiB and removes a per-byte loop.
 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// --- Helpers ----------------------------------------------------------------

const encoder = new TextEncoder();

/** Converts epoch milliseconds into the packed DOS date/time pair. */
export const toDosDateTime = (
  timestamp: number,
): { readonly date: number; readonly time: number } => {
  const source = new Date(timestamp);
  const year = source.getFullYear();
  // Dates before the DOS epoch cannot be represented; clamp rather than wrap,
  // because a wrapped date would look like a corrupt archive to a reader.
  if (year < DOS_EPOCH_YEAR) return { date: (1 << 5) | 1, time: 0 };

  const date = ((year - DOS_EPOCH_YEAR) << 9) | ((source.getMonth() + 1) << 5) | source.getDate();
  const time =
    (source.getHours() << 11) | (source.getMinutes() << 5) | Math.floor(source.getSeconds() / 2);
  return { date, time };
};

/** Rejects a path that would escape the archive root. */
export const isSafeEntryPath = (path: string): boolean => {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    const buffer = new Uint8Array(2);
    new DataView(buffer.buffer).setUint16(0, value & 0xffff, true);
    this.push(buffer);
  }

  u32(value: number): void {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, value >>> 0, true);
    this.push(buffer);
  }

  text(value: string): void {
    this.push(encoder.encode(value));
  }

  concat(): Uint8Array {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

// --- Writer -----------------------------------------------------------------

export interface ZipResult {
  readonly bytes: Uint8Array;
  readonly entryCount: number;
  readonly totalBytes: number;
}

/**
 * Builds a ZIP archive from the given entries.
 *
 * Throws when an entry path is unsafe or an entry exceeds the format limits,
 * rather than emitting an archive that a reader would reject — a corrupt bundle
 * discovered at analysis time is worse than a loud failure at export time.
 */
export const createZip = (entries: readonly ZipEntry[]): ZipResult => {
  const writer = new ByteWriter();
  const central: {
    readonly path: string;
    readonly crc: number;
    readonly size: number;
    readonly offset: number;
    readonly date: number;
    readonly time: number;
  }[] = [];

  let totalBytes = 0;

  for (const entry of entries) {
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`unsafe zip entry path: ${JSON.stringify(entry.path)}`);
    }

    const content = encoder.encode(entry.content);
    if (content.length > MAX_ENTRY_BYTES) {
      throw new Error(`zip entry too large: ${entry.path} (${content.length} bytes)`);
    }
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("zip archive too large for the non-ZIP64 format");
    }

    const pathBytes = encoder.encode(entry.path);
    const crc = crc32(content);
    const { date, time } = toDosDateTime(entry.modifiedAt);
    const offset = writer.offset;

    // Local file header.
    writer.u32(0x04034b50);
    writer.u16(20); // version needed
    writer.u16(0); // flags
    writer.u16(0); // method: store
    writer.u16(time);
    writer.u16(date);
    writer.u32(crc);
    writer.u32(content.length); // compressed size == uncompressed for store
    writer.u32(content.length);
    writer.u16(pathBytes.length);
    writer.u16(0); // extra field length
    writer.push(pathBytes);
    writer.push(content);

    central.push({ path: entry.path, crc, size: content.length, offset, date, time });
  }

  const centralStart = writer.offset;

  for (const record of central) {
    const pathBytes = encoder.encode(record.path);
    writer.u32(0x02014b50);
    writer.u16(20); // version made by
    writer.u16(20); // version needed
    writer.u16(0); // flags
    writer.u16(0); // method: store
    writer.u16(record.time);
    writer.u16(record.date);
    writer.u32(record.crc);
    writer.u32(record.size);
    writer.u32(record.size);
    writer.u16(pathBytes.length);
    writer.u16(0); // extra
    writer.u16(0); // comment
    writer.u16(0); // disk number
    writer.u16(0); // internal attributes
    writer.u32(0); // external attributes
    writer.u32(record.offset);
    writer.push(pathBytes);
  }

  const centralSize = writer.offset - centralStart;

  // End of central directory.
  writer.u32(0x06054b50);
  writer.u16(0); // this disk
  writer.u16(0); // disk with central directory
  writer.u16(central.length);
  writer.u16(central.length);
  writer.u32(centralSize);
  writer.u32(centralStart);
  writer.u16(0); // comment length

  return { bytes: writer.concat(), entryCount: central.length, totalBytes };
};

// --- Reader -----------------------------------------------------------------

export interface ReadZipEntry {
  readonly path: string;
  readonly content: string;
}

/**
 * Reads back a store-only archive.
 *
 * Exists so tests can prove a generated bundle is genuinely readable rather
 * than merely well-formed — an archive that only our writer understands would
 * fail at exactly the moment it is needed.
 */
export const readZip = (bytes: Uint8Array): readonly ReadZipEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate the end-of-central-directory record. It is last, but a comment could
  // in principle follow it, so scan backwards within the maximum comment size.
  let eocd = -1;
  const earliest = Math.max(0, bytes.length - (22 + 0xffff));
  for (let index = bytes.length - 22; index >= earliest; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive: no end-of-central-directory record");

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  const entries: ReadZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`corrupt zip: bad central directory header at ${cursor}`);
    }
    const method = view.getUint16(cursor + 10, true);
    if (method !== 0) throw new Error("unsupported zip compression method; expected store");
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const path = decoder.decode(nameBytes);

    // Local header: skip to the data, allowing for a differing name/extra
    // length, which some writers exploit to hide data.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const content = decoder.decode(bytes.subarray(dataStart, dataStart + size));

    entries.push({ path, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
};

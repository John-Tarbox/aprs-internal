/**
 * Tiny no-dependency ZIP encoder. Store-only (no compression) — for
 * the data-export endpoint (P6) where the bottleneck is D1/R2 reads,
 * not byte size. Output is a standard ZIP that any zip tool reads.
 *
 * Format reference: PKWARE APPNOTE.TXT § 4.3 (local file header,
 * central directory, end of central directory). Store-only means we
 * skip compression — `compression method` is 0 and the compressed-
 * size = uncompressed-size.
 *
 * The CRC32 implementation is the standard reflected-polynomial
 * variant (poly 0xEDB88320). Not cryptographic; required by the ZIP
 * spec for integrity.
 */

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  crc32: number;
  /** Offset of this entry's local header within the output. */
  offset: number;
}

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeUint16LE(view: DataView, offset: number, val: number): void {
  view.setUint16(offset, val, true);
}
function writeUint32LE(view: DataView, offset: number, val: number): void {
  view.setUint32(offset, val >>> 0, true);
}

/**
 * Build a complete ZIP archive in memory from a list of {name, bytes}
 * entries. Returns a single Uint8Array suitable for `new Response(...)`.
 */
export function buildZip(files: Array<{ name: string; bytes: Uint8Array | string }>): Uint8Array {
  const enc = new TextEncoder();
  // Normalize to bytes + compute CRC for each entry up-front.
  const entries: ZipEntry[] = files.map((f) => {
    const bytes = typeof f.bytes === 'string' ? enc.encode(f.bytes) : f.bytes;
    return { name: f.name, bytes, crc32: crc32(bytes), offset: 0 };
  });

  // Compute total output size so we can allocate a single buffer.
  // Local header is 30 bytes + name; data is bytes; central dir entry
  // is 46 bytes + name; end of central dir is 22 bytes.
  const nameByteLengths = entries.map((e) => enc.encode(e.name).length);
  let localSize = 0;
  for (let i = 0; i < entries.length; i++) {
    localSize += 30 + nameByteLengths[i] + entries[i].bytes.length;
  }
  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) {
    centralSize += 46 + nameByteLengths[i];
  }
  const totalSize = localSize + centralSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  // Write local file headers + data, recording each entry's offset.
  let pos = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    e.offset = pos;
    const nameBytes = enc.encode(e.name);
    writeUint32LE(view, pos, 0x04034b50);            // local file header signature
    writeUint16LE(view, pos + 4, 20);                // version needed
    writeUint16LE(view, pos + 6, 0);                 // general purpose bit flag
    writeUint16LE(view, pos + 8, 0);                 // compression method = stored
    writeUint16LE(view, pos + 10, 0);                // last mod time (omitted)
    writeUint16LE(view, pos + 12, 0);                // last mod date (omitted)
    writeUint32LE(view, pos + 14, e.crc32);          // CRC-32
    writeUint32LE(view, pos + 18, e.bytes.length);   // compressed size
    writeUint32LE(view, pos + 22, e.bytes.length);   // uncompressed size
    writeUint16LE(view, pos + 26, nameBytes.length); // file name length
    writeUint16LE(view, pos + 28, 0);                // extra field length
    out.set(nameBytes, pos + 30);
    out.set(e.bytes, pos + 30 + nameBytes.length);
    pos += 30 + nameBytes.length + e.bytes.length;
  }

  // Write central directory.
  const centralOffset = pos;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nameBytes = enc.encode(e.name);
    writeUint32LE(view, pos, 0x02014b50);            // central file header signature
    writeUint16LE(view, pos + 4, 20);                // version made by
    writeUint16LE(view, pos + 6, 20);                // version needed
    writeUint16LE(view, pos + 8, 0);                 // gp bit flag
    writeUint16LE(view, pos + 10, 0);                // compression method
    writeUint16LE(view, pos + 12, 0);                // mod time
    writeUint16LE(view, pos + 14, 0);                // mod date
    writeUint32LE(view, pos + 16, e.crc32);          // CRC
    writeUint32LE(view, pos + 20, e.bytes.length);   // compressed size
    writeUint32LE(view, pos + 24, e.bytes.length);   // uncompressed size
    writeUint16LE(view, pos + 28, nameBytes.length); // file name length
    writeUint16LE(view, pos + 30, 0);                // extra field length
    writeUint16LE(view, pos + 32, 0);                // comment length
    writeUint16LE(view, pos + 34, 0);                // disk number start
    writeUint16LE(view, pos + 36, 0);                // internal file attrs
    writeUint32LE(view, pos + 38, 0);                // external file attrs
    writeUint32LE(view, pos + 42, e.offset);         // local header offset
    out.set(nameBytes, pos + 46);
    pos += 46 + nameBytes.length;
  }

  // End of central directory record.
  writeUint32LE(view, pos, 0x06054b50);
  writeUint16LE(view, pos + 4, 0);                   // disk number
  writeUint16LE(view, pos + 6, 0);                   // disk where central dir starts
  writeUint16LE(view, pos + 8, entries.length);      // number of entries on this disk
  writeUint16LE(view, pos + 10, entries.length);     // total entries
  writeUint32LE(view, pos + 12, pos - centralOffset);// central dir size
  writeUint32LE(view, pos + 16, centralOffset);      // central dir offset
  writeUint16LE(view, pos + 20, 0);                  // comment length
  return out;
}

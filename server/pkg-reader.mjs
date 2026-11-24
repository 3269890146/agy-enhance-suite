/**
 * PKG 容器读取与场景内嵌 MP4 提取器
 * 源自 MIT 许可的 dsh-wallpaper-engine (lib/pkg-read.js & lib/scene-manifest.js) 并精简适配。
 * 仅读取头部目录索引表并按需切片读取，避免把大体积 scene.pkg 整包载入内存。
 */
import { createReadStream, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_PKG_ENTRY_BYTES = 512 * 1024 * 1024;
const PKG_ENTRY_FLAG_LZ4 = 1;
const textDecoder = new TextDecoder('utf-8');

class Reader {
  constructor(data, label = 'pkg') {
    this.data = data;
    this.label = label;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = 0;
  }
  get remaining() {
    return this.view.byteLength - this.pos;
  }
  need(n) {
    if (n < 0 || this.pos + n > this.view.byteLength) {
      throw new Error(`${this.label}: unexpected end of data`);
    }
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64() {
    const lo = this.u32();
    const hi = this.u32();
    return hi * 0x100000000 + lo;
  }
  bytes(n) {
    this.need(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  sizedString(maxLength) {
    const length = this.i32();
    if (length < 0 || length > maxLength) {
      throw new Error(`${this.label}: invalid string length ${length}`);
    }
    return textDecoder.decode(this.bytes(length));
  }
}

function lz4DecompressBlock(src, dstSize) {
  if (dstSize < 0 || dstSize > MAX_DECOMPRESSED_BYTES) {
    throw new Error(`lz4: decompressed size out of bounds (${dstSize})`);
  }
  const dst = new Uint8Array(dstSize);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let s;
      do {
        if (ip >= src.length) throw new Error('lz4: truncated literal length');
        s = src[ip++];
        literalLength += s;
      } while (s === 255);
    }
    if (ip + literalLength > src.length || op + literalLength > dstSize) {
      throw new Error('lz4: literal run out of bounds');
    }
    dst.set(src.subarray(ip, ip + literalLength), op);
    ip += literalLength;
    op += literalLength;
    if (ip >= src.length) break;
    if (ip + 2 > src.length) throw new Error('lz4: truncated match offset');
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error(`lz4: invalid match offset ${offset}`);
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let s;
      do {
        if (ip >= src.length) throw new Error('lz4: truncated match length');
        s = src[ip++];
        matchLength += s;
      } while (s === 255);
    }
    matchLength += 4;
    if (op + matchLength > dstSize) throw new Error('lz4: match run out of bounds');
    for (let i = 0; i < matchLength; i++) {
      dst[op] = dst[op - offset];
      op++;
    }
  }
  if (op !== dstSize) {
    throw new Error(`lz4: size mismatch (${op} != ${dstSize})`);
  }
  return dst;
}

function parsePkgIndexHead(head) {
  const r = new Reader(head, 'pkg');
  const magic = r.sizedString(32);
  if (!/^PKGV\d{4}$/.test(magic)) {
    throw new Error(`pkg: bad magic '${magic}'`);
  }
  const count = r.i32();
  if (count < 0 || count > 0x100000) {
    throw new Error(`pkg: invalid entry count ${count}`);
  }
  const index = [];
  for (let i = 0; i < count; i++) {
    index.push({ path: r.sizedString(1024), offset: r.u32(), length: r.u32() });
  }
  return { index, dataStart: r.pos };
}

async function probeCompressedEntryAt(readAt, abs, length) {
  if (length < 8) return null;
  const head = await readAt(abs, 8);
  if (head.byteLength < 8) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const originalSize = view.getUint32(0, true) + view.getUint32(4, true) * 0x100000000;
  if (originalSize <= length || originalSize > 0x7fffffff) return null;
  let pos = abs + 8;
  let total = 0;
  while (total < originalSize) {
    if (pos + 8 > abs + length) return null;
    const hdr = await readAt(pos, 8);
    if (hdr.byteLength < 8) return null;
    const hdrView = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    const uncomp = hdrView.getInt32(0, true);
    const comp = hdrView.getInt32(4, true);
    if (uncomp <= 0 || comp <= 0 || pos + 8 + comp > abs + length) return null;
    total += uncomp;
    pos += 8 + comp;
  }
  return total === originalSize && pos === abs + length ? originalSize : null;
}

function decompressLz4Entry(compressed, entry) {
  if (entry.size > MAX_PKG_ENTRY_BYTES) {
    throw new Error(`pkg: entry '${entry.path}' too large`);
  }
  const r = new Reader(compressed, 'pkg');
  const originalSize = r.u64();
  if (originalSize !== entry.size) throw new Error(`pkg: entry '${entry.path}' size mismatch`);
  const out = new Uint8Array(entry.size);
  let written = 0;
  while (written < entry.size) {
    const uncomp = r.i32();
    const comp = r.i32();
    if (uncomp <= 0 || comp <= 0 || written + uncomp > entry.size) {
      throw new Error(`pkg: corrupt compressed entry '${entry.path}'`);
    }
    out.set(lz4DecompressBlock(r.bytes(comp), uncomp), written);
    written += uncomp;
  }
  return out;
}

async function parsePkgHead(readAt, fileSize) {
  const size = Number(fileSize) || 0;
  const attempts = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];
  if (attempts[attempts.length - 1] < size) attempts.push(size);
  let lastErr = null;
  for (const want of attempts) {
    const take = Math.min(want, size);
    let head;
    try {
      head = await readAt(0, take);
    } catch (e) {
      lastErr = e;
      continue;
    }
    let index, dataStart;
    try {
      ({ index, dataStart } = parsePkgIndexHead(head));
    } catch (e) {
      if (e?.message?.endsWith('unexpected end of data')) {
        lastErr = e;
        continue;
      }
      throw e;
    }
    const entries = [];
    for (const { path, offset, length } of index) {
      const abs = dataStart + offset;
      if (abs + length > size) throw new Error(`pkg: entry '${path}' out of bounds`);
      const originalSize = await probeCompressedEntryAt(readAt, abs, length);
      entries.push(
        originalSize === null
          ? { path, offset: abs, compressedSize: length, size: length, flags: 0 }
          : { path, offset: abs, compressedSize: length, size: originalSize, flags: PKG_ENTRY_FLAG_LZ4 }
      );
    }
    return entries;
  }
  throw lastErr || new Error('pkg: unexpected end of data');
}

async function readPkgEntryAt(readAt, fileSize, entry) {
  const abs = entry.offset;
  if (abs < 0 || abs + entry.compressedSize > Number(fileSize)) {
    throw new Error(`pkg: entry '${entry.path}' out of bounds`);
  }
  if ((entry.flags & PKG_ENTRY_FLAG_LZ4) === 0) {
    return readAt(abs, entry.compressedSize);
  }
  const compressed = await readAt(abs, entry.compressedSize);
  return decompressLz4Entry(compressed, entry);
}

async function readPkgEntryHeadAt(readAt, fileSize, entry, n) {
  const want = Math.max(0, Math.min(Number(n) || 0, entry.size));
  if (want === 0) return new Uint8Array(0);
  if ((entry.flags & PKG_ENTRY_FLAG_LZ4) === 0) {
    return readAt(entry.offset, want);
  }
  const full = await readPkgEntryAt(readAt, fileSize, entry);
  return full.subarray(0, want);
}

function findFtypOffset(bytes, length) {
  const limit = Math.min(200, Math.max(0, length - 8));
  for (let i = 4; i < limit; i++) {
    if (bytes[i] === 0x66 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x79 && bytes[i + 3] === 0x70) {
      return i - 4;
    }
  }
  return -1;
}

function scoreTexPath(p) {
  const lower = p.toLowerCase();
  const bad = ['mask', 'flow', 'wave', 'noise', 'lut', 'distort', 'warp', 'vortex', 'glow', 'neon', 'overlay', 'watermark', 'logo', 'particle', 'audio', 'lightmap'];
  if (bad.some((k) => lower.includes(k))) return -100;
  let score = 0;
  if (lower.includes('day') || lower.includes('main') || lower.includes('background') || lower.includes('wallpaper') || lower.includes('白天')) score += 50;
  if (lower.endsWith('.mp4')) score += 60;
  return score;
}

/**
 * 从 scene.pkg 中提取内嵌 MP4 并缓存至 cacheFilePath，用作 WebWallGL 失败时的二级视频降级。
 */
export async function extractEmbeddedMp4ToCache(pkgPath, cacheFilePath) {
  if (existsSync(cacheFilePath)) {
    try {
      const st = statSync(cacheFilePath);
      if (st.size > 1024) return cacheFilePath;
    } catch { /* ignore */ }
  }
  if (!existsSync(pkgPath)) return null;
  const fh = await open(pkgPath, 'r');
  try {
    const st = await fh.stat();
    const readAt = async (pos, len) => {
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    };
    const entries = await parsePkgHead(readAt, st.size);
    const candidates = entries
      .filter((e) => /\.(tex|mp4)$/i.test(e.path) && e.size > 16384)
      .sort((a, b) => scoreTexPath(b.path) - scoreTexPath(a.path));

    for (const entry of candidates) {
      const head = await readPkgEntryHeadAt(readAt, st.size, entry, 212);
      const ftypOffset = findFtypOffset(head, entry.size);
      if (ftypOffset >= 0) {
        const full = await readPkgEntryAt(readAt, st.size, entry);
        const mp4Bytes = full.subarray(ftypOffset);
        if (mp4Bytes.byteLength > 4096) {
          mkdirSync(join(cacheFilePath, '..'), { recursive: true });
          writeFileSync(cacheFilePath, mp4Bytes);
          return cacheFilePath;
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

export { createReadStream, stat };

/**
 * 分享包 ZIP 读写（不引第三方库）。
 *
 * 写：只用「存储」方式（method 0）。图片本身已压缩，再 deflate 只费时间；
 * 文件名按 UTF-8 写并置通用标志位 11；偏移或条目数超出 32 位/16 位时自动写 ZIP64。
 * 读：只读中央目录，按条目随机读取（Blob.slice），支持存储与 deflate（浏览器自带
 * DecompressionStream），支持 ZIP64、UTF-8 标志、Info-ZIP Unicode Path 扩展字段，
 * 无 UTF-8 标志的旧包按 UTF-8 → GBK 依次尝试（Windows 资源管理器的中文包）。
 * 加密条目、其它压缩方式直接拒绝；解压时按中央目录声明的大小封顶并核对 CRC32。
 *
 * 本文件不 import 任何模块：Node 可直接加载做往返测试。
 */

/* ---- CRC32（IEEE，查表） ---- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** 增量 CRC32：首次传 0，返回值可继续喂下一段 */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---- 常量 ---- */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNIX_TIME = 0x5455;
const EXTRA_UNICODE_PATH = 0x7075;

/** 文件内容上限：单张图片不允许 ≥ 4 GB（本地头不写 ZIP64 尺寸，保持读写两侧简单） */
const MAX_ENTRY_SIZE = U32_MAX - 1;

/** 读条目时为本地头的名称 + 扩展字段预留的余量（不够时补读一次） */
const LOCAL_HEADER_SLACK = 1024;

/* ---- 小端读写 ---- */

function setU64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value % 0x1_0000_0000, true);
  view.setUint32(offset + 4, Math.floor(value / 0x1_0000_0000), true);
}

function getU64(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  const value = hi * 0x1_0000_0000 + lo;
  if (!Number.isSafeInteger(value)) throw new Error("ZIP 中的数值超出可处理范围");
  return value;
}

/** epoch ms → DOS 日期/时间（本地时区，2 秒精度；1980 年前按 1980-01-01） */
function toDosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(ms);
  if (!Number.isFinite(ms) || d.getFullYear() < 1980) {
    return { date: (0 << 9) | (1 << 5) | 1, time: 0 };
  }
  const year = Math.min(d.getFullYear(), 2107) - 1980;
  return {
    date: (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

const utf8 = new TextEncoder();

/* ---- 写 ---- */

/** 写出目标：通常是 FileSystemWritableFileStream 的薄封装 */
export interface ZipSink {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
}

interface CentralRecord {
  name: Uint8Array<ArrayBuffer>;
  crc: number;
  size: number;
  offset: number;
  date: number;
  time: number;
  unixSeconds: number;
}

/**
 * 顺序写 ZIP：addFile 逐个追加（整段数据由调用方读入内存），finish 写中央目录。
 * 同名条目由调用方保证不重复（这里只按字节比较兜底）。
 */
export class ZipWriter {
  private readonly sink: ZipSink;
  private readonly records: CentralRecord[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private finished = false;

  constructor(sink: ZipSink) {
    this.sink = sink;
  }

  /** 已写出的字节数 */
  get bytesWritten(): number {
    return this.offset;
  }

  private async emit(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.sink.write(chunk);
    this.offset += chunk.length;
  }

  async addFile(name: string, data: Uint8Array<ArrayBuffer>, mtime: number): Promise<void> {
    if (this.finished) throw new Error("ZIP 已结束写入");
    if (data.length > MAX_ENTRY_SIZE) throw new Error(`单个文件超过 4 GB：${name}`);
    const key = name.toLowerCase();
    if (this.names.has(key)) throw new Error(`分享包内路径重复：${name}`);
    this.names.add(key);

    const nameBytes = utf8.encode(name);
    if (nameBytes.length > U16_MAX) throw new Error(`文件路径过长：${name}`);
    const crc = crc32(data);
    const { date, time } = toDosDateTime(mtime);
    const unixSeconds = Math.max(0, Math.min(U32_MAX, Math.floor(mtime / 1000)));

    // 本地头：30 字节 + 名称 + UT 扩展（9 字节：标记 + 修改时间）
    const extraLen = 9;
    const header = new Uint8Array(30 + nameBytes.length + extraLen);
    const view = new DataView(header.buffer);
    view.setUint32(0, SIG_LOCAL, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, 0, true); // stored
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, extraLen, true);
    header.set(nameBytes, 30);
    const extraAt = 30 + nameBytes.length;
    view.setUint16(extraAt, EXTRA_UNIX_TIME, true);
    view.setUint16(extraAt + 2, 5, true);
    view.setUint8(extraAt + 4, 1); // 只带 mtime
    view.setUint32(extraAt + 5, unixSeconds, true);

    const offset = this.offset;
    await this.emit(header);
    await this.emit(data);
    this.records.push({ name: nameBytes, crc, size: data.length, offset, date, time, unixSeconds });
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const cdStart = this.offset;
    for (const r of this.records) {
      const needs64 = r.offset >= U32_MAX;
      const zip64Len = needs64 ? 12 : 0; // 头 4 + 偏移 8
      const extraLen = 9 + zip64Len;
      const buf = new Uint8Array(46 + r.name.length + extraLen);
      const view = new DataView(buf.buffer);
      view.setUint32(0, SIG_CENTRAL, true);
      view.setUint16(4, 45, true); // version made by（MS-DOS 主机，4.5）
      view.setUint16(6, needs64 ? 45 : 20, true);
      view.setUint16(8, FLAG_UTF8, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, r.time, true);
      view.setUint16(14, r.date, true);
      view.setUint32(16, r.crc, true);
      view.setUint32(20, r.size, true);
      view.setUint32(24, r.size, true);
      view.setUint16(28, r.name.length, true);
      view.setUint16(30, extraLen, true);
      view.setUint16(32, 0, true); // comment
      view.setUint16(34, 0, true); // disk
      view.setUint16(36, 0, true); // internal attrs
      view.setUint32(38, 0, true); // external attrs（普通文件）
      view.setUint32(42, needs64 ? U32_MAX : r.offset, true);
      buf.set(r.name, 46);
      let at = 46 + r.name.length;
      view.setUint16(at, EXTRA_UNIX_TIME, true);
      view.setUint16(at + 2, 5, true);
      view.setUint8(at + 4, 1);
      view.setUint32(at + 5, r.unixSeconds, true);
      at += 9;
      if (needs64) {
        view.setUint16(at, EXTRA_ZIP64, true);
        view.setUint16(at + 2, 8, true);
        setU64(view, at + 4, r.offset);
      }
      await this.emit(buf);
    }
    const cdSize = this.offset - cdStart;
    const count = this.records.length;
    const needs64 = count >= U16_MAX || cdStart >= U32_MAX || cdSize >= U32_MAX;
    if (needs64) {
      const zip64At = this.offset;
      const rec = new Uint8Array(56);
      const v = new DataView(rec.buffer);
      v.setUint32(0, SIG_ZIP64_EOCD, true);
      setU64(v, 4, 44); // 记录剩余长度
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setUint32(16, 0, true);
      v.setUint32(20, 0, true);
      setU64(v, 24, count);
      setU64(v, 32, count);
      setU64(v, 40, cdSize);
      setU64(v, 48, cdStart);
      await this.emit(rec);
      const loc = new Uint8Array(20);
      const lv = new DataView(loc.buffer);
      lv.setUint32(0, SIG_ZIP64_LOCATOR, true);
      lv.setUint32(4, 0, true);
      setU64(lv, 8, zip64At);
      lv.setUint32(16, 1, true);
      await this.emit(loc);
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, needs64 ? U16_MAX : count, true);
    ev.setUint16(10, needs64 ? U16_MAX : count, true);
    ev.setUint32(12, needs64 ? U32_MAX : cdSize, true);
    ev.setUint32(16, needs64 ? U32_MAX : cdStart, true);
    ev.setUint16(20, 0, true);
    await this.emit(end);
  }
}

/* ---- 读 ---- */

export interface ZipEntry {
  /** 包内路径（原样，未做安全校验；目录条目以 / 结尾） */
  name: string;
  isDirectory: boolean;
  /** 0 = 存储，8 = deflate */
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** version made by 的高字节：3 = Unix（此时 externalAttrs 高 16 位是 st_mode） */
  hostSystem: number;
  externalAttrs: number;
}

async function readBytes(blob: Blob, start: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  if (start < 0 || length < 0 || start + length > blob.size) {
    throw new Error("ZIP 结构损坏（读取越界）");
  }
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

let gbkDecoder: TextDecoder | null | undefined;

function decodeName(bytes: Uint8Array, flags: number, unicodeExtra: string | null): string {
  if (flags & FLAG_UTF8) return new TextDecoder("utf-8").decode(bytes);
  if (unicodeExtra !== null) return unicodeExtra;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (gbkDecoder === undefined) {
      try {
        gbkDecoder = new TextDecoder("gbk");
      } catch {
        gbkDecoder = null;
      }
    }
    if (gbkDecoder) return gbkDecoder.decode(bytes);
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** 读中央目录（不解压任何内容）。不是 ZIP / 结构损坏时抛出可读错误。 */
export async function readZipDirectory(blob: Blob): Promise<ZipEntry[]> {
  if (blob.size < 22) throw new Error("不是有效的 ZIP 文件");
  const tailLen = Math.min(blob.size, 22 + U16_MAX);
  const tailStart = blob.size - tailLen;
  const tail = await readBytes(blob, tailStart, tailLen);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（找不到目录结尾）");
  if (tv.getUint16(eocd + 4, true) !== 0 || tv.getUint16(eocd + 6, true) !== 0) {
    throw new Error("不支持分卷 ZIP");
  }
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);

  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const locAt = tailStart + eocd - 20;
    if (locAt < 0) throw new Error("ZIP64 结构损坏");
    const loc = await readBytes(blob, locAt, 20);
    const lv = new DataView(loc.buffer);
    if (lv.getUint32(0, true) !== SIG_ZIP64_LOCATOR) throw new Error("ZIP64 结构损坏（缺少定位记录）");
    const recAt = getU64(lv, 8);
    const rec = await readBytes(blob, recAt, 56);
    const rv = new DataView(rec.buffer);
    if (rv.getUint32(0, true) !== SIG_ZIP64_EOCD) throw new Error("ZIP64 结构损坏（缺少目录记录）");
    count = getU64(rv, 32);
    cdSize = getU64(rv, 40);
    cdOffset = getU64(rv, 48);
  }
  if (count > 500_000) throw new Error("ZIP 内条目过多（上限 500,000）");

  const cd = await readBytes(blob, cdOffset, cdSize);
  const view = new DataView(cd.buffer);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > cd.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error("ZIP 目录损坏");
    }
    const madeBy = view.getUint16(p + 4, true);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const externalAttrs = view.getUint32(p + 38, true);
    let localOffset = view.getUint32(p + 42, true);
    const nameStart = p + 46;
    const extraStart = nameStart + nameLen;
    const next = extraStart + extraLen + commentLen;
    if (next > cd.length) throw new Error("ZIP 目录损坏");
    const nameBytes = cd.subarray(nameStart, extraStart);

    let unicodeName: string | null = null;
    let q = extraStart;
    const extraEnd = extraStart + extraLen;
    while (q + 4 <= extraEnd) {
      const id = view.getUint16(q, true);
      const len = view.getUint16(q + 2, true);
      const body = q + 4;
      if (body + len > extraEnd) break;
      if (id === EXTRA_ZIP64) {
        let r = body;
        if (size === U32_MAX && r + 8 <= body + len) {
          size = getU64(view, r);
          r += 8;
        }
        if (compressedSize === U32_MAX && r + 8 <= body + len) {
          compressedSize = getU64(view, r);
          r += 8;
        }
        if (localOffset === U32_MAX && r + 8 <= body + len) {
          localOffset = getU64(view, r);
        }
      } else if (id === EXTRA_UNICODE_PATH && len > 5 && view.getUint8(body) === 1) {
        // 版本 1 + 原名 CRC32 + UTF-8 名；CRC 不符说明原名被改过，忽略
        const storedCrc = view.getUint32(body + 1, true);
        if (storedCrc === crc32(nameBytes)) {
          unicodeName = new TextDecoder("utf-8").decode(cd.subarray(body + 5, body + len));
        }
      }
      q = body + len;
    }

    const name = decodeName(nameBytes, flags, unicodeName);
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      method,
      flags,
      crc,
      compressedSize,
      size,
      localOffset,
      hostSystem: madeBy >> 8,
      externalAttrs,
    });
    p = next;
  }
  return entries;
}

/** Unix 主机写入的符号链接（st_mode 高位 0xA000） */
export function isSymlinkEntry(entry: ZipEntry): boolean {
  return entry.hostSystem === 3 && ((entry.externalAttrs >>> 16) & 0xf000) === 0xa000;
}

/** 条目是否可读：加密或未知压缩方式返回原因，可读返回 null */
export function unsupportedReason(entry: ZipEntry): string | null {
  if (entry.flags & FLAG_ENCRYPTED) return "加密的 ZIP 条目";
  if (entry.method !== 0 && entry.method !== 8) return `不支持的压缩方式（${entry.method}）`;
  if (isSymlinkEntry(entry)) return "符号链接";
  return null;
}

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const out = new Uint8Array(limit);
  let filled = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (filled + value.length > limit) {
        throw new Error("解压后的大小与包内记录不符");
      }
      out.set(value, filled);
      filled += value.length;
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  if (filled !== limit) throw new Error("解压后的大小与包内记录不符");
  return out;
}

/** 读出并校验一个条目的内容（大小与 CRC32 都要对上） */
export async function readZipEntry(blob: Blob, entry: ZipEntry): Promise<Uint8Array<ArrayBuffer>> {
  const reason = unsupportedReason(entry);
  if (reason) throw new Error(`${reason}：${entry.name}`);
  // 本地头与数据一次读出：本地头的名称/扩展字段长度要读了头才知道，先按余量多读一点，
  // 余量不够（极少见的超长扩展字段）再补读数据段
  const chunkEnd = Math.min(
    blob.size,
    entry.localOffset + 30 + LOCAL_HEADER_SLACK + entry.compressedSize,
  );
  const chunk = await readBytes(blob, entry.localOffset, chunkEnd - entry.localOffset);
  if (chunk.length < 30) throw new Error(`ZIP 条目损坏：${entry.name}`);
  const hv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (hv.getUint32(0, true) !== SIG_LOCAL) throw new Error(`ZIP 条目损坏：${entry.name}`);
  const dataOffset = 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const dataStart = entry.localOffset + dataOffset;
  if (dataStart + entry.compressedSize > blob.size) throw new Error(`ZIP 条目损坏：${entry.name}`);
  const raw =
    dataOffset + entry.compressedSize <= chunk.length
      ? chunk.subarray(dataOffset, dataOffset + entry.compressedSize)
      : await readBytes(blob, dataStart, entry.compressedSize);
  let data: Uint8Array<ArrayBuffer>;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new Error(`ZIP 条目损坏：${entry.name}`);
    data = raw;
  } else {
    const stream = new Blob([raw])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw")) as ReadableStream<Uint8Array>;
    try {
      data = await collect(stream, entry.size);
    } catch (err) {
      throw new Error(
        `解压失败：${entry.name}（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
  }
  if (crc32(data) !== entry.crc) throw new Error(`文件校验失败（CRC32 不符）：${entry.name}`);
  return data;
}

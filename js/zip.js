/*!
 * ClearPrint · zip.js — 零依赖 store-only ZIP（压缩方法 0 = 不压缩）
 *
 * 为什么不用 compression：图片本身已压缩，再 deflate 收益 <1%，
 * 而实现 deflate 要引第三方库。store-only 的 ZIP 结构简单、可控、能断言。
 *
 * 结构：LOCAL FILE HEADER + data ... → CENTRAL DIRECTORY → EOCD
 * 中文文件名必须置 UTF-8 标志位（bit 11 = 0x0800），否则 Windows 解出来是乱码。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZIP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // CRC32 查表（ZIP 规范用的就是标准 CRC-32/ISO-HDLC）
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // node 兜底
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }

  /** 本地时间 → DOS 时间/日期对 */
  function dosDateTime(d) {
    const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
    const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time, date };
  }

  const SIG_LOCAL = 0x04034B50;
  const SIG_CENTRAL = 0x02014B50;
  const SIG_EOCD = 0x06054B50;

  /**
   * 打包。entries = [{ name, data: Uint8Array|Blob }]
   * 全程用 Uint8Array 拼接（Blob 版本在 Safari 上拼 arrayBuffer 会爆内存）。
   */
  async function build(entries, onProgress) {
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosDateTime(new Date());

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let data = e.data;
      if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
      else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      const nameBytes = utf8(e.name);
      const crc = crc32(data);
      const size = data.length;

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, SIG_LOCAL, true);
      lv.setUint16(4, 20, true);          // 需要的版本 2.0
      lv.setUint16(6, 0x0800, true);      // ★ UTF-8 文件名标志
      lv.setUint16(8, 0, true);           // 压缩方法 0 = store
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);          // extra 长度
      lh.set(nameBytes, 30);

      parts.push(lh, data);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, SIG_CENTRAL, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);          // 外部属性
      cv.setUint32(42, offset, true);     // 本地头偏移
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + size;
      if (onProgress) onProgress((i + 1) / entries.length, e.name);
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, 0, true);
    parts.push(eocd);

    return new Blob(parts, { type: 'application/zip' });
  }

  return { build, crc32 };
});

/*!
 * ClearPrint · cv.js — 纯图像处理核（无 DOM、无 ORT 依赖）
 *
 * UMD：浏览器挂 window.CV；Worker 里 importScripts 拿全局；node 里 require。
 * 主线程与 Worker 共用同一份实现 —— 缩放算法必须完全一致，否则掩码与图对不齐。
 *
 * 约定：
 *   img  = {data: Uint8ClampedArray|Uint8Array(RGBA), width, height}
 *   mask = {data: Uint8ClampedArray|Uint8Array 单通道 0..255, width, height}
 *   所有坐标一律 [x, y]，左上角原点。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CV = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 基础

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * 掩码一律带 width/height 与 w/h 两套别名。
   * ★ 血的教训：生产端产出 {width,height}、消费端读 {w,h}，
   *   字段名不一致会让整条批量通路 100% 失败，而两侧各自单测都是绿的。
   *   与其到处防御，不如让结构本身没有两种叫法。
   */
  function mask(w, h, data) {
    const m = {
      data: data || new Uint8ClampedArray(w * h),
      width: w, height: h,
      get w() { return this.width; },
      get h() { return this.height; },
    };
    return m;
  }

  function newMask(w, h) {
    return mask(w, h);
  }

  function copyMask(m) {
    const { width, height } = dims(m);
    return mask(width, height, new Uint8ClampedArray(m.data));
  }

  /** 从任意掩码对象取出宽高（兼容 {w,h} 与 {width,height} 两种写法） */
  function dims(m) {
    const width = m.width != null ? m.width : m.w;
    const height = m.height != null ? m.height : m.h;
    return { width, height };
  }

  /** 掩码里是否至少有一个前景像素 */
  function hasMask(m) {
    if (!m || !m.data) return false;
    const d = m.data;
    for (let i = 0; i < d.length; i++) if (d[i] > 0) return true;
    return false;
  }

  /** 前景像素个数（>threshold） */
  function countMask(m, threshold) {
    if (!m || !m.data) return 0;
    const t = threshold == null ? 0 : threshold;
    let n = 0;
    const d = m.data;
    for (let i = 0; i < d.length; i++) if (d[i] > t) n++;
    return n;
  }

  // ---------------------------------------------------------------- 双线性缩放
  // 半像素中心对齐：src = (dst + 0.5) * scale - 0.5
  // 绝不用 canvas drawImage —— 它的采样约定不同的实现可能有出入，
  // 这里必须能跟 Python/numpy 参考实现对拍到亚像素级。

  function bilinearRGBA(src, sw, sh, dw, dh) {
    const dst = new Uint8ClampedArray(dw * dh * 4);
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return dst;
    const sx = sw / dw, sy = sh / dh;

    // 预计算 x 方向的索引与权重
    const xi0 = new Int32Array(dw), xi1 = new Int32Array(dw), xw = new Float64Array(dw);
    for (let x = 0; x < dw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      let x0 = Math.floor(fx);
      let w1 = fx - x0;
      let x1 = x0 + 1;
      if (x0 >= sw - 1) { x0 = sw - 1; x1 = sw - 1; w1 = 0; }
      xi0[x] = x0; xi1[x] = x1; xw[x] = w1;
    }

    for (let y = 0; y < dh; y++) {
      let fy = (y + 0.5) * sy - 0.5;
      if (fy < 0) fy = 0;
      let y0 = Math.floor(fy);
      let wy = fy - y0;
      let y1 = y0 + 1;
      if (y0 >= sh - 1) { y0 = sh - 1; y1 = sh - 1; wy = 0; }

      const r0 = y0 * sw, r1 = y1 * sw, ro = y * dw * 4;
      for (let x = 0; x < dw; x++) {
        const a = xi0[x], b = xi1[x], wx = xw[x];
        const a0 = (r0 + a) * 4, a1 = (r0 + b) * 4, b0 = (r1 + a) * 4, b1 = (r1 + b) * 4;
        const o = ro + x * 4;
        const w00 = (1 - wy) * (1 - wx), w01 = (1 - wy) * wx;
        const w10 = wy * (1 - wx), w11 = wy * wx;
        for (let c = 0; c < 4; c++) {
          dst[o + c] = src[a0 + c] * w00 + src[a1 + c] * w01 +
                       src[b0 + c] * w10 + src[b1 + c] * w11;
        }
      }
    }
    return dst;
  }

  /** 单通道掩码的双线性缩放（返回 Float32 未量化，避免连续缩放累积误差） */
  function bilinearGrayF(src, sw, sh, dw, dh) {
    const dst = new Float32Array(dw * dh);
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return dst;
    const sx = sw / dw, sy = sh / dh;
    const xi0 = new Int32Array(dw), xi1 = new Int32Array(dw), xw = new Float64Array(dw);
    for (let x = 0; x < dw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      let x0 = Math.floor(fx);
      let w1 = fx - x0, x1 = x0 + 1;
      if (x0 >= sw - 1) { x0 = sw - 1; x1 = sw - 1; w1 = 0; }
      xi0[x] = x0; xi1[x] = x1; xw[x] = w1;
    }
    for (let y = 0; y < dh; y++) {
      let fy = (y + 0.5) * sy - 0.5;
      if (fy < 0) fy = 0;
      let y0 = Math.floor(fy);
      let wy = fy - y0, y1 = y0 + 1;
      if (y0 >= sh - 1) { y0 = sh - 1; y1 = sh - 1; wy = 0; }
      const r0 = y0 * sw, r1 = y1 * sw, ro = y * dw;
      for (let x = 0; x < dw; x++) {
        const a = xi0[x], b = xi1[x], wx = xw[x];
        dst[ro + x] = src[r0 + a] * (1 - wy) * (1 - wx) + src[r0 + b] * (1 - wy) * wx +
                      src[r1 + a] * wy * (1 - wx) + src[r1 + b] * wy * wx;
      }
    }
    return dst;
  }

  function scaleMask(m, dw, dh) {
    const f = bilinearGrayF(m.data, m.width, m.height, dw, dh);
    const out = new Uint8ClampedArray(dw * dh);
    for (let i = 0; i < f.length; i++) out[i] = f[i];
    return mask(dw, dh, out);
  }

  // ---------------------------------------------------------------- 形态学

  /** 方形核膨胀（可分离：先横后纵，O(n·r) 而非 O(n·r²)） */
  function dilate(m, radius) {
    const r = Math.max(0, Math.round(radius || 0));
    if (r === 0) return copyMask(m);
    const w = m.width, h = m.height;
    const tmp = new Uint8ClampedArray(w * h);
    const out = new Uint8ClampedArray(w * h);
    const src = m.data;
    // 横向
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = 0;
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        for (let k = x0; k <= x1; k++) { const s = src[row + k]; if (s > v) v = s; }
        tmp[row + x] = v;
      }
    }
    // 纵向
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = 0;
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
        for (let k = y0; k <= y1; k++) { const s = tmp[k * w + x]; if (s > v) v = s; }
        out[y * w + x] = v;
      }
    }
    return mask(w, h, out);
  }

  function erode(m, radius) {
    const r = Math.max(0, Math.round(radius || 0));
    if (r === 0) return copyMask(m);
    // 腐蚀 = 255 - 膨胀(255 - m)
    const inv = new Uint8ClampedArray(m.data.length);
    for (let i = 0; i < inv.length; i++) inv[i] = 255 - m.data[i];
    const d = dilate(mask(m.width, m.height, inv), r);
    const out = new Uint8ClampedArray(m.data.length);
    for (let i = 0; i < out.length; i++) out[i] = 255 - d.data[i];
    return mask(m.width, m.height, out);
  }

  function closeMask(m, radius) { return erode(dilate(m, radius), radius); }

  /**
   * 羽化：单次可分离 box blur，边界按「边缘延拓」（等价 np.pad(mode='edge')）。
   * 输入输出都是 0..255 尺度 —— 内部只做窗口均值，不做归一化。
   * 与 Python 参考实现严格一致（不要擅自换成高斯×3，那会让边界值对不上）。
   */
  function feather(m, radius) {
    const r = Math.max(0, Math.round(radius || 0));
    if (r === 0) return copyMask(m);
    const w = m.width, h = m.height;
    const win = r * 2 + 1;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    // 横向：先算 x=0 的窗口和，再滑动
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += m.data[row + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc += m.data[row + clamp(x + r + 1, 0, w - 1)] - m.data[row + clamp(x - r, 0, w - 1)];
      }
    }
    // 纵向
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / win;
        acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
      }
    }
    const res = new Uint8ClampedArray(w * h);
    for (let i = 0; i < out.length; i++) res[i] = out[i];
    return mask(w, h, res);
  }

  // ---------------------------------------------------------------- 掩码编辑

  function fillRect(m, x, y, w, h, value) {
    const v = value == null ? 255 : value;
    const x0 = clamp(Math.round(x), 0, m.width), x1 = clamp(Math.round(x + w), 0, m.width);
    const y0 = clamp(Math.round(y), 0, m.height), y1 = clamp(Math.round(y + h), 0, m.height);
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * m.width;
      for (let xx = x0; xx < x1; xx++) m.data[row + xx] = v;
    }
    return m;
  }

  function fillEllipse(m, cx, cy, rx, ry, value) {
    const v = value == null ? 255 : value;
    const x0 = clamp(Math.floor(cx - rx), 0, m.width), x1 = clamp(Math.ceil(cx + rx), 0, m.width);
    const y0 = clamp(Math.floor(cy - ry), 0, m.height), y1 = clamp(Math.ceil(cy + ry), 0, m.height);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const dx = (xx + 0.5 - cx) / rx, dy = (yy + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) m.data[yy * m.width + xx] = v;
      }
    }
    return m;
  }

  /** 把掩码按相对比例投递到另一分辨率（模板套用的核心） */
  function remapMask(m, dw, dh) { return scaleMask(m, dw, dh); }

  function clearMask(m) { m.data.fill(0); return m; }

  function invertMask(m) {
    const d = m.data;
    for (let i = 0; i < d.length; i++) d[i] = 255 - d[i];
    return m;
  }

  /** 反色 / 透明像素一并覆盖：用于「全图水印」场景 */
  function silhouetteMask(img, threshold) {
    const t = threshold == null ? 12 : threshold;
    const w = img.width, h = img.height;
    const out = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = img.data[p + 3] > t ? 255 : 0;
    }
    return mask(w, h, out);
  }

  // ---------------------------------------------------------------- 包围盒 / ROI

  function bbox(m, threshold) {
    const t = threshold == null ? 0 : threshold;
    let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
    const { width: w, height: h } = dims(m);
    const d = m.data;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (d[row + x] > t) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /**
   * 把包围盒扩成一个目标边长 512 的方形 ROI，并保持原图纵横比（不拉伸）。
   * 返回 {x, y, w, h} 在整图坐标系；越界部分由调用方用「边缘延拓」补齐。
   */
  function planRoi(box, imgW, imgH, target, marginScale) {
    const T = target || 512;
    const ms = marginScale == null ? 1.35 : marginScale;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const side = Math.max(box.w, box.h) * ms;
    // 不少于 T 的 1/6，避免小掩码导致的极端放大
    const s = Math.max(side, T / 6);
    let w, h;
    if (imgW >= imgH) { w = Math.max(s, imgW * (s / Math.max(imgW, imgH))); h = 0; }
    // 直接用方形：本身就不变形
    w = s; h = s;
    let x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);
    return { x, y, w: Math.round(w), h: Math.round(h) };
  }

  /**
   * 从整图裁出 ROI，越界部分用边缘像素延拓（edge pad）补齐后再缩放到 size×size。
   * 返回 {data: Uint8ClampedArray(RGBA), width: size, height: size}。
   * 边缘延拓很关键：补零会在图上压出黑边，模型会把黑边当成内容画进去。
   */
  function cropToTensor(img, roi, size) {
    const T = size || 512;
    const sw = roi.w, sh = roi.h;
    const crop = new Uint8ClampedArray(sw * sh * 4);
    const { width: W, height: H, data: src } = img;
    for (let y = 0; y < sh; y++) {
      const sy = clamp(roi.y + y, 0, H - 1);
      for (let x = 0; x < sw; x++) {
        const sx = clamp(roi.x + x, 0, W - 1);
        const si = (sy * W + sx) * 4, di = (y * sw + x) * 4;
        crop[di] = src[si]; crop[di + 1] = src[si + 1];
        crop[di + 2] = src[si + 2]; crop[di + 3] = src[si + 3];
      }
    }
    return bilinearRGBA(crop, sw, sh, T, T);
  }

  /** 同样带边缘延拓地裁出掩码，缩放到 size×size，输出 0/1 float 数组 */
  function cropMaskToTensor(softMask, roi, size, threshold) {
    const T = size || 512;
    const th = threshold == null ? 127 : threshold;
    const sw = roi.w, sh = roi.h;
    const crop = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const sy = clamp(roi.y + y, 0, softMask.height - 1);
      for (let x = 0; x < sw; x++) {
        const sx = clamp(roi.x + x, 0, softMask.width - 1);
        crop[y * sw + x] = softMask.data[sy * softMask.width + sx] > th ? 1 : 0;
      }
    }
    return bilinearGrayF(crop, sw, sh, T, T);
  }

  /**
   * 把 size×size 的结果贴回整图（按 roi 尺寸缩放回来，仅覆盖 roi 区域）。
   * outRGBA 可以是 {data} 对象或裸 Uint8ClampedArray（内部已统一）。
   * 原地修改 img，并返回 img。
   */
  function pasteResult(img, outRGBA, roi, size) {
    const T = size || 512;
    const src = outRGBA && outRGBA.data ? outRGBA.data : outRGBA;
    const back = bilinearRGBA(src, T, T, roi.w, roi.h);
    const { width: W, height: H, data: dst } = img;
    for (let y = 0; y < roi.h; y++) {
      const dy = roi.y + y;
      if (dy < 0 || dy >= H) continue;
      for (let x = 0; x < roi.w; x++) {
        const dx = roi.x + x;
        if (dx < 0 || dx >= W) continue;
        const si = (y * roi.w + x) * 4, di = (dy * W + dx) * 4;
        dst[di] = back[si]; dst[di + 1] = back[si + 1];
        dst[di + 2] = back[si + 2];
        // alpha 不动 —— 透明水印的 alpha 是原图的，别被推理结果污染
      }
    }
    return img;
  }

  const api = {
    clamp, mask, newMask, copyMask, dims, hasMask, countMask,
    bilinearRGBA, bilinearGrayF, scaleMask, remapMask,
    dilate, erode, closeMask, feather,
    fillRect, fillEllipse, clearMask, invertMask, silhouetteMask,
    bbox, planRoi, cropToTensor, cropMaskToTensor, pasteResult,
  };
  // node 下也暴露成全局，方便脚本直接 eval
  if (typeof self !== 'undefined') self.CV = api;
  return api;
});

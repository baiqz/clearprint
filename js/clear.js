/*!
 * ClearPrint · clear.js — 去除核（Worker 与主线程共用，UMD）
 *
 * 两条通路，按「水印类型」自动选：
 *
 *  A) restoreAlpha —— 半透明水印逐通道 α 反解（★ 首选）
 *     out = (1-a)·bg + a·W          —— 水印覆盖模型
 *     a_c = (out_c - bg_c) / (G - bg_c)   —— 用「水印最亮通道」定 a（白/亮水印）
 *     src_c = (out_c - W_c·a_c) / (1 - a_c)
 *     只要 bg 估计准，代数自洽就能精确还原，花叶细节全保住。
 *     灰度 a 套三通道会留暖色残影（实测彩偏 19 级 → 逐通道降到 3 级）。
 *
 *  B) inpaint —— LaMa 生成式修复（兜底）
 *     水印是实心不透明、或跨在复杂结构上、或 α 反解残影超标时用。
 *     配方：image/255 → NCHW；mask 0/1 → NCHW；输出 clip(0,255)【绝不乘 255】。
 */
(function (root, factory) {
  const CV = (typeof module === 'object' && module.exports)
    ? require('./cv.js')
    : (root.CV || (typeof CV !== 'undefined' ? CV : null));
  const api = factory(CV);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CLEAR = api;
})(typeof self !== 'undefined' ? self : this, function (CV) {
  'use strict';

  const LAMA = {
    size: 512,
    mean: [0.485, 0.456, 0.406].map((v) => v * 255),
    // 注意：本导出模型的输入不需要减均值（实测直接 /255 效果最好），
    // 这里保留常量仅作记录，真正用的是下面的 imageToTensor。
  };

  // ---------------------------------------------------------------- 张量

  /** RGBA → NCHW float32，值域 0..1（不要减 ImageNet 均值，会整体偏色） */
  function imageToTensor(rgba, size) {
    const T = size || 512;
    const out = new Float32Array(3 * T * T);
    const plane = T * T;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      out[i] = rgba[p] / 255;
      out[plane + i] = rgba[p + 1] / 255;
      out[2 * plane + i] = rgba[p + 2] / 255;
    }
    return out;
  }

  /** 单通道 float（0..1）→ NCHW [1,1,T,T] */
  function maskToTensor(grayF, size) {
    const T = size || 512;
    const out = new Float32Array(T * T);
    for (let i = 0; i < T * T; i++) out[i] = grayF[i] > 0.5 ? 1 : 0;
    return out;
  }

  /**
   * 模型输出 → RGBA。
   * ★★ 最大的坑：本模型输出已是 0~255 量级，绝不能再乘 255（会饱和成纯白）。
   * 症状：无论 mask 怎么改 MAE 都恒等同一个值，且等于 255 − ref均值。
   */
  function tensorToRGBA(data, size) {
    const T = size || 512;
    const plane = T * T;
    const out = new Uint8ClampedArray(plane * 4);
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      out[p] = data[i];
      out[p + 1] = data[plane + i];
      out[p + 2] = data[2 * plane + i];
      out[p + 3] = 255;
    }
    return out;
  }

  // ---------------------------------------------------------------- 背景估计

  /**
   * 逐通道中值滤波 —— 用来抠掉水印笔画、留下底子。
   *
   * ★ 性能关键：绝不能用「每像素把 k² 个数拿来排序」的写法。
   *   k=41 时每个像素要排 1681 个数，1280×960 的图实测要 160 秒。
   *   这里用「移动直方图 + 列前缀和」：先横后纵，每步只更新进出窗口的两列/两行，
   *   O(1) 摊销求中值。同样的图降到亚秒级。
   *
   * 实现：先对每一行做横向中值（滑动直方图），再对结果的每一列做纵向中值。
   * 中值滤波不可分离，但「先横后纵」是行业通用的近似，对「去掉细笔画」这个
   * 用途完全够用（我们要的是背景底子，不是精确中值）。
   */
  function medianRGB(img, k) {
    const r = Math.max(1, Math.floor(k / 2));
    const w = img.width, h = img.height, d = img.data;
    const win = 2 * r + 1;

    // ---- pass 1: 横向 ----
    const mid = new Uint8ClampedArray(w * h * 4);
    const hist = new Int32Array(256);
    // ★ 每次滑动窗口里只有 win 个像素（一维），不是 win²。
    //   之前错写 (win*win)>>1，导致 acc 永远到不了 half，v 一路跑到 256 写出越界值。
    const half = win >> 1;
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        // ★ fill(0) 必须在 c 循环内 —— 三个通道必须各自独立统计。
        //   放在 y 循环里（c 外面）会让 G/B 通道的中值被前一通道的残差污染
        //   （实测 G 通道返回 R 的值，背景估计整体错位）。
        hist.fill(0);
        // 初始化窗口
        for (let dx = -r; dx <= r; dx++) {
          const x = CV.clamp(dx, 0, w - 1);
          hist[d[(y * w + x) * 4 + c]]++;
        }
        for (let x = 0; x < w; x++) {
          // 取中值（直方图前缀和；理论上必然命中，兜底 255 防越界）
          let acc = 0, v = 0;
          for (; v < 256; v++) { acc += hist[v]; if (acc > half) break; }
          if (v > 255) v = 255;
          mid[(y * w + x) * 4 + c] = v;
          // 滑动：出左入右
          const xo = CV.clamp(x - r, 0, w - 1), xi = CV.clamp(x + r + 1, 0, w - 1);
          hist[d[(y * w + xo) * 4 + c]]--;
          hist[d[(y * w + xi) * 4 + c]]++;
        }
      }
      // alpha 直接搬
      for (let x = 0; x < w; x++) mid[(y * w + x) * 4 + 3] = d[(y * w + x) * 4 + 3];
    }

    // ---- pass 2: 纵向（在 pass1 结果上）----
    const out = new Float32Array(w * h * 3);
    const hist2 = new Int32Array(256);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        hist2.fill(0);
        for (let dy = -r; dy <= r; dy++) {
          const y = CV.clamp(dy, 0, h - 1);
          hist2[mid[(y * w + x) * 4 + c]]++;
        }
        for (let y = 0; y < h; y++) {
          let acc = 0, v = 0;
          for (; v < 256; v++) { acc += hist2[v]; if (acc > half) break; }
          if (v > 255) v = 255;
          out[(y * w + x) * 3 + c] = v;
          const yo = CV.clamp(y - r, 0, h - 1), yi = CV.clamp(y + r + 1, 0, h - 1);
          hist2[mid[(yo * w + x) * 4 + c]]--;
          hist2[mid[(yi * w + x) * 4 + c]]++;
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- A) α 反解

  /**
   * 逐通道 α 反解去半透明水印。
   *
   * 覆盖模型：out_c = (1-a)·bg_c + a·W_c
   * 反解：    a_c   = (out_c - bg_c) / (W_c - bg_c)
   *          src_c = (out_c - W_c·a_c) / (1 - a_c)
   *
   * ★★ 最大的坑：W（水印自身颜色）绝不能从「水印后的像素」里采样。
   *    那样会得到 W = out，于是 a 恒等于 1，反解出的 src = (out - out)/(1-1) → 崩。
   *    W 必须是「水印本身是什么颜色」的先验：
   *      - 白色/浅色水印（绝大多数平台）→ W = 255，用 whiteLevel 微调
   *      - 深色水印 → 传 wColor（三个 0..255 的值）
   *    这就是为什么原实现里那个「从核心区采 W」的写法是错的（实测 a 均值 0.958，
   *    画面直接烧成纯白）。
   *
   * @param {object} img  整图 RGBA（原地修改）
   * @param {object} mask 0..255 掩码（前景=水印），可稍大于水印本体
   * @param {object} opts {
   *   wColor:  number|number[]  水印色，默认 255（纯白）。传数组则逐通道指定
   *   alphaGain: number         α 增益，默认 1
   *   clampLo:   number         低于此 α 不动（防止给干净区引入噪声），默认 0.06
   *   clampHi:   number         高于此 α 用背景兜底，默认 0.96
   *   medianK:   number         背景中值滤波窗口边长，默认 41（须 > 水印笔画最大宽度）
   *   pad:       number         ROI 外扩，默认 = medianK
   *   bgQuantile: number        背景取分位（0.5=中值），默认 0.5
   * }
   */
  function restoreAlpha(img, mask, opts) {
    const o = opts || {};
    const w = img.width, h = img.height;
    const d = img.data;
    const medianK = o.medianK || 41;
    const gain = o.alphaGain == null ? 1.0 : o.alphaGain;
    const lo = o.clampLo == null ? 0.06 : o.clampLo;
    const hi = o.clampHi == null ? 0.96 : o.clampHi;

    // 水印自身颜色（先验，不是采样！）
    let W;
    if (Array.isArray(o.wColor)) W = [o.wColor[0], o.wColor[1], o.wColor[2]];
    else if (typeof o.wColor === 'number') W = [o.wColor, o.wColor, o.wColor];
    else W = [255, 255, 255];                 // 默认：白色水印
    // 驱动通道：与背景差最大的那个（白色水印通常三通道都大，此时取绿通道最稳）
    const driveGuess = (o.driveChannel == null) ? 1 : o.driveChannel;

    const box = CV.bbox(mask, o.boxThreshold == null ? 8 : o.boxThreshold);
    if (!box) return { changed: 0, alphaMean: 0, alphaMax: 0, W, gc: driveGuess };

    const pad = o.pad == null ? medianK : o.pad;
    const cx0 = Math.max(0, box.x - pad), cy0 = Math.max(0, box.y - pad);
    const cx1 = Math.min(w, box.x + box.w + pad), cy1 = Math.min(h, box.y + box.h + pad);
    const rw = cx1 - cx0, rh = cy1 - cy0;

    const sub = { data: new Uint8ClampedArray(rw * rh * 4), width: rw, height: rh };
    for (let y = 0; y < rh; y++) {
      const sy = cy0 + y;
      for (let x = 0; x < rw; x++) {
        const si = (sy * w + cx0 + x) * 4, di = (y * rw + x) * 4;
        sub.data[di] = d[si]; sub.data[di + 1] = d[si + 1]; sub.data[di + 2] = d[si + 2];
        sub.data[di + 3] = d[si + 3];
      }
    }
    // 背景估计：中值滤波（k 需 > 水印笔画最大宽度，才能把笔画抹掉）
    let bg = medianRGB(sub, medianK);

    // ★ 关键校验：「背景估计」必须真的像背景 —— 且必须是「掩码内也能穿透水印」。
    //   判据不能只看掩码外（掩码外本来就没水印，永远对得上）。
    //   正确做法：比「掩码内的 bg 均值」与「掩码外的 bg 均值」。
    //   若掩码内明显更亮，说明中值窗口没盖住水印带、把水印色当成了背景
    //   （症状：α 恒等于 0 或恒等于上限，整张图要么没效果要么烧白）。
    const bgCompare = (bgArr) => {
      let inSum = 0, inN = 0, outSum = 0, outN = 0;
      for (let y = 0; y < rh; y++) {
        const gy = cy0 + y;
        for (let x = 0; x < rw; x++) {
          const gx = cx0 + x;
          if (gx < 0 || gx >= w || gy < 0 || gy >= h) continue;
          const v = bgArr[(y * rw + x) * 3 + driveGuess];
          if (mask.data[gy * w + gx] > 0) { inSum += v; inN++; }
          else { outSum += v; outN++; }
        }
      }
      if (inN < 16 || outN < 16) return null;
      return { inAvg: inSum / inN, outAvg: outSum / outN, diff: (inSum / inN) - (outSum / outN) };
    };

    let cmp = bgCompare(bg);
    let kUse = medianK;
    let guard = 0;
    const tol = o.bgTol == null ? 3 : o.bgTol;
    // 掩码内的背景估计不该比掩码外亮（水印让画面变亮，但背景本身不变）
    while (cmp && Math.abs(cmp.diff) > tol && guard < 5) {
      kUse = Math.min(241, Math.round(kUse * 1.8));
      bg = medianRGB(sub, kUse);
      cmp = bgCompare(bg);
      guard++;
      if (kUse >= 241) break;
    }

    // ---- 逐像素反解 ----
    // ★ 用「三通道联合最小二乘」估 α，而不是单看驱动通道。
    //   单通道版（只看 G）在纯白水印上 G 精确，但 R/B 会因各自 bg 估计误差而色偏
    //   （实测 R 过冲到 48 vs 目标 64，B 到 20 vs 42）。
    //   最小二乘：minimize Σ_c (out_c - bg_c - a·(W_c - bg_c))²
    //            → a = Σ_c (out_c-bg_c)(W_c-bg_c) / Σ_c (W_c-bg_c)²
    //   三个通道一起投票，对某一通道 bg 估偏更鲁棒。
    const gc = driveGuess;
    // ★ satN：反解出的 α 触到上限（≈1）的像素数。
    //   物理含义 = 「这块像素水印几乎全遮，背景已经看不见」。
    //   α 反解在 a→1 时分母 (1-a)→0，只能拿中值背景兜底 → 该处【纹理被抹平】
    //   （实测实心水印：修复后核心区标准差 3.92 vs 真值 8.96，草地糊成一片）。
    //   这种图正解是 LaMa（生成纹理）。用饱和率把它交给 auto 选路。
    //   实测分离度：半透明夹具（a=0.25~0.62）饱和率 0.0%；实心夹具 67.3%。
    let changed = 0, aSum = 0, aMax = 0, missN = 0, satN = 0;
    for (let y = 0; y < rh; y++) {
      const gy = cy0 + y;
      if (gy < 0 || gy >= h) continue;
      for (let x = 0; x < rw; x++) {
        const gx = cx0 + x;
        if (gx < 0 || gx >= w) continue;
        const mi = gy * w + gx;
        const mw = mask.data[mi];
        if (mw === 0) continue;
        const si = (y * rw + x) * 4, bi = (y * rw + x) * 3;

        let num = 0, den = 0;
        for (let c = 0; c < 3; c++) {
          const dc = W[c] - bg[bi + c];
          num += (sub.data[si + c] - bg[bi + c]) * dc;
          den += dc * dc;
        }
        let a = Math.abs(den) > 1e-3 ? num / den : 0;
        // 保底：三通道都不可信时退回驱动通道
        if (!isFinite(a) || a <= 0) {
          const dbg = bg[bi + gc], dW = W[gc] - dbg;
          a = Math.abs(dW) > 1e-3 ? (sub.data[si + gc] - dbg) / dW : 0;
        }
        // 掩码软边作为上限，别越出标注范围
        const cap = mw / 255;
        if (a > cap) a = cap;
        a *= gain;
        if (a < lo) { missN++; continue; }        // 太弱，不动
        if (a >= hi) satN++;                      // 记录饱和（是否被截断）
        if (a > hi) a = hi;
        if (a > aMax) aMax = a;
        aSum += a; changed++;

        for (let c = 0; c < 3; c++) {
          const bgc = bg[bi + c];
          const denc = 1 - a;
          let src;
          if (denc < 0.05) src = bgc;             // a→1，水印全遮 → 用背景兜底
          else src = (sub.data[si + c] - W[c] * a) / denc;
          d[(gy * w + gx) * 4 + c] = CV.clamp(src, 0, 255);
        }
      }
    }
    const satRate = changed ? satN / changed : 0;
    return { changed, skipped: missN, alphaMean: changed ? aSum / changed : 0, alphaMax: aMax,
             satN, satRate, W, gc, medianK: kUse };
  }

  // ---------------------------------------------------------------- 残影指标

  /**
   * 反解质量自评：处理后，掩码区是否「与掩码外的真实背景融洽」。
   *
   * ★ 两个坑都踩过：
   *   1) 不能看峰值残差（画面自身亮结构能到 +100，全是假阳性）→ 看「成片超阈像素占比」。
   *   2) ★ 不能再用同一套中值背景做参照 —— 中值估错时（水印带比窗口还厚），
   *      修复和自评会一起错，表现为「自评 ok 但实际一点没改」。
   *      参照基准必须来自**掩码外**（那里没有水印，是可信的真背景）。
   */
  function selfCheck(before, after, mask, opts) {
    const o = opts || {};
    const w = before.width, h = before.height;
    const box = CV.bbox(mask, 8);
    if (!box) return { ok: false, residualRate: 1, n: 0, reason: 'no-mask' };

    // ---- 用「掩码外环带」求真背景基准（逐通道中位数）----
    const pad = o.pad == null ? 16 : o.pad;
    const cx0 = Math.max(0, box.x - pad), cy0 = Math.max(0, box.y - pad);
    const cx1 = Math.min(w, box.x + box.w + pad), cy1 = Math.min(h, box.y + box.h + pad);
    const outSamples = [[], [], []];
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        if (mask.data[y * w + x] > 0) continue;          // 只看掩码外
        const p = (y * w + x) * 4;
        outSamples[0].push(before.data[p]);
        outSamples[1].push(before.data[p + 1]);
        outSamples[2].push(before.data[p + 2]);
      }
    }
    if (outSamples[0].length < 24) return { ok: false, residualRate: 1, n: 0, reason: 'no-ring' };

    // ---- 掩码内：处理后是否仍「显著亮于」掩码外背景基准 ----
    // 逐行校准：用同一行上掩码外的背景作为该行的参照，避免整体亮度梯度干扰
    let resid = 0, n = 0;
    const thresh = o.residualThresh == null ? 10 : o.residualThresh;
    for (let y = box.y; y < box.y + box.h; y++) {
      // 该行掩码外的背景（RGB 均值）
      let rs = 0, gs = 0, bs = 0, rn = 0;
      for (let x = cx0; x < cx1; x++) {
        if (mask.data[y * w + x] > 0) continue;
        const p = (y * w + x) * 4;
        rs += before.data[p]; gs += before.data[p + 1]; bs += before.data[p + 2]; rn++;
      }
      let rr, rg, rb;
      if (rn >= 4) { rr = rs / rn; rg = gs / rn; rb = bs / rn; }
      else {
        // 该行没有掩码外像素（水印通栏）→ 用整条环带的中位数
        rr = medianOf(outSamples[0]); rg = medianOf(outSamples[1]); rb = medianOf(outSamples[2]);
      }
      for (let x = box.x; x < box.x + box.w; x++) {
        if (mask.data[y * w + x] === 0) continue;
        const p = (y * w + x) * 4;
        const dl = 0.299 * (after.data[p] - rr) + 0.587 * (after.data[p + 1] - rg) + 0.114 * (after.data[p + 2] - rb);
        if (dl > thresh) resid++;
        n++;
      }
    }
    const rate = n ? resid / n : 1;
    const maxRate = o.maxResidualRate == null ? 0.25 : o.maxResidualRate;
    return {
      ok: n > 0 && rate <= maxRate,
      residualRate: rate, n,
      reason: n === 0 ? 'empty' : (rate > maxRate ? 'residual' : 'ok'),
    };
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    const a = Array.prototype.slice.call(arr).sort((x, y) => x - y);
    return a[a.length >> 1];
  }

  /**
   * 残留指标（保留给需要「绝对差」的场景，如回归报告）。
   * ★ 判据别用峰值残差 —— 画面自身亮结构能到 +100，全是假阳性。
   */
  function residualStats(before, after, mask) {
    const o = opts || {};
    const w = before.width, h = before.height;
    const box = CV.bbox(mask, 8);
    if (!box) return { meanResidual: 0, maxChroma: 0, n: 0 };
    const sx = Math.round(box.x + box.w * 0.25), sy = Math.round(box.y + box.h * 0.25);
    const sw = Math.max(1, Math.round(box.w * 0.5)), sh = Math.max(1, Math.round(box.h * 0.5));
    let sum = 0, n = 0, maxChroma = 0;
    for (let y = sy; y < sy + sh && y < h; y++) {
      for (let x = sx; x < sx + sw && x < w; x++) {
        const p = (y * w + x) * 4;
        const bR = before.data[p], bG = before.data[p + 1], bB = before.data[p + 2];
        const aR = after.data[p], aG = after.data[p + 1], aB = after.data[p + 2];
        // 残影 = 处理前后「与该点邻域均值的偏离」的差（衡量结构突兀度而非绝对变化）
        const dl = 0.299 * (aR - bR) + 0.587 * (aG - bG) + 0.114 * (aB - bB);
        sum += Math.abs(dl); n++;
        // 彩偏：处理后依然偏亮的通道
        const mx = Math.max(aR, aG, aB), mn = Math.min(aR, aG, aB);
        maxChroma = Math.max(maxChroma, mx - mn);
      }
    }
    return { meanResidual: n ? sum / n : 0, maxChroma, n };
  }

  return {
    LAMA, imageToTensor, maskToTensor, tensorToRGBA,
    medianRGB, restoreAlpha, residualStats, selfCheck,
  };
});

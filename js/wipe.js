/*!
 * ClearPrint · wipe.js — 水印自动探测与候选区生成
 *
 * 设计原则（踩坑换来的）：
 *  1. 「判某区有没有水印」绝不能看单点最大亮度 —— 纸纹/高光噪点单点就能超标。
 *     一律改看「成行/成片的超阈像素数」。水印笔画成行几十像素，噪声每行 ≤1。
 *  2. 水印大多是「半透明的浅色叠加」，特点是与局部背景比是**局部亮**，
 *     所以用「背景中值滤波估计 → 残差」而不是绝对阈值。
 *  3. 只输出候选框 + 置信度，最终是否处理交给用户确认（或用户直接涂抹）。
 *
 * UMD：window.WIPE / importScripts 全局 / node require。
 */
(function (root, factory) {
  const CV = (typeof module === 'object' && module.exports)
    ? require('./cv.js')
    : (root.CV || (typeof CV !== 'undefined' ? CV : null));
  const api = factory(CV);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WIPE = api;
})(typeof self !== 'undefined' ? self : this, function (CV) {
  'use strict';

  // ---------------------------------------------------------------- 灰度 / 局部背景

  /** 感知亮度（ITU-R BT.601，与主流实现一致） */
  function luma(img) {
    const n = img.width * img.height;
    const out = new Float32Array(n);
    const d = img.data;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
    return out;
  }

  /**
   * 中值滤波估计「背景」：水印是浅色叠加，宽度有限，
   * 中值能把笔画抹掉、留下底子。k 取 ~ 最大笔画宽度的 2~3 倍。
   */
  function medianFilter(gray, w, h, k) {
    const r = Math.max(1, Math.floor(k / 2));
    const out = new Float32Array(w * h);
    const win = new Float32Array((2 * r + 1) * (2 * r + 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let dy = -r; dy <= r; dy++) {
          const sy = CV.clamp(y + dy, 0, h - 1) * w;
          for (let dx = -r; dx <= r; dx++) {
            win[n++] = gray[sy + CV.clamp(x + dx, 0, w - 1)];
          }
        }
        const sub = win.subarray(0, n);
        Array.prototype.sort.call(sub, (a, b) => a - b);
        out[y * w + x] = sub[n >> 1];
      }
    }
    return out;
  }

  /** 高效近似中值：把窗口切成 3×3 的小块的均值，再取这些小块的 max —— 近似「上背景」。
   *  仅用于大图快速版，精度不如真中值但快 20 倍。 */
  function upBackground(gray, w, h, cell) {
    const c = Math.max(4, Math.round(cell || Math.min(w, h) / 24));
    const gw = Math.ceil(w / c), gh = Math.ceil(h / c);
    const grid = new Float32Array(gw * gh);
    const cnt = new Float32Array(gw * gh);
    for (let y = 0; y < h; y++) {
      const gy = (y / c) | 0;
      for (let x = 0; x < w; x++) {
        const gi = gy * gw + ((x / c) | 0);
        grid[gi] += gray[y * w + x];
        cnt[gi] += 1;
      }
    }
    for (let i = 0; i < grid.length; i++) grid[i] = cnt[i] ? grid[i] / cnt[i] : 0;
    // 3×3 max —— 取「较亮的邻居」作为背景基线
    const base = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const y = CV.clamp(gy + dy, 0, gh - 1);
          for (let dx = -1; dx <= 1; dx++) {
            const s = grid[y * gw + CV.clamp(gx + dx, 0, gw - 1)];
            if (s > v) v = s;
          }
        }
        base[gy * gw + gx] = v;
      }
    }
    // 上采样回原尺寸（双线性）
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = x / c - 0.5, gy = y / c - 0.5;
        const x0 = CV.clamp(Math.floor(gx), 0, gw - 1), y0 = CV.clamp(Math.floor(gy), 0, gh - 1);
        const x1 = CV.clamp(x0 + 1, 0, gw - 1), y1 = CV.clamp(y0 + 1, 0, gh - 1);
        const wx = CV.clamp(gx - Math.floor(gx), 0, 1), wy = CV.clamp(gy - Math.floor(gy), 0, 1);
        const v00 = base[y0 * gw + x0], v01 = base[y0 * gw + x1];
        const v10 = base[y1 * gw + x0], v11 = base[y1 * gw + x1];
        out[y * w + x] = v00 * (1 - wx) * (1 - wy) + v01 * wx * (1 - wy) +
                         v10 * (1 - wx) * wy + v11 * wx * wy;
      }
    }
    return out;
  }

  /**
   * ★ 核心判据：区域内「成行超出背景的像素数」统计。
   * 返回 {rows, rowHits, hitRatio, strength, maxRun}
   *  - rowHits: 有多少行存在 ≥minRun 个连续/累计超阈像素
   *  - maxRun : 单行最长连续超阈长度
   * 噪声（纸纹/颗粒）每行最多 1~2 个孤立点，不构成 run。
   */
  function rowProfile(gray, back, w, h, ox, oy, rw, rh, delta) {
    const d = delta == null ? 6 : delta;
    let maxRun = 0, rowsHit = 0, tot = 0, sq = 0, cnt = 0;
    const hitRows = [];
    for (let y = 0; y < rh; y++) {
      const sy = oy + y, base = sy * w;
      let run = 0, best = 0, hits = 0;
      for (let x = 0; x < rw; x++) {
        const sx = ox + x;
        const diff = gray[base + sx] - back[base + sx];
        if (diff > d) { run++; hits++; if (run > best) best = run; }
        else run = 0;
        tot += diff; sq += diff * diff; cnt++;
      }
      if (best > maxRun) maxRun = best;
      if (hits >= 2) { rowsHit++; hitRows.push(y); }
    }
    const mean = cnt ? tot / cnt : 0;
    const varr = cnt ? Math.max(0, sq / cnt - mean * mean) : 0;
    return {
      maxRun, rowsHit, hitRows,
      rowRatio: rh ? rowsHit / rh : 0,
      meanDiff: mean,
      stdDiff: Math.sqrt(varr),
    };
  }

  // ---------------------------------------------------------------- 候选区

  /**
   * 生成水印候选区（相对坐标，0..1）。
   * 覆盖典型位置：四角 + 底部中 + 顶部中 + 中心（很多平台打中心大水印）。
   */
  function candidateRegions(aspect) {
    const S = [0.34, 0.14];        // 角区宽高比基准
    const M = 0.01;                // 距边
    const W = S[0], H = S[1];
    const list = [
      { key: 'br', name: '右下', x: 1 - M - W, y: 1 - M - H, w: W, h: H },
      { key: 'bl', name: '左下', x: M, y: 1 - M - H, w: W, h: H },
      { key: 'tr', name: '右上', x: 1 - M - W, y: M, w: W, h: H },
      { key: 'tl', name: '左上', x: M, y: M, w: W, h: H },
      { key: 'bc', name: '底部中', x: (1 - W) / 2, y: 1 - M - H * 1.35, w: W, h: H * 1.35 },
      { key: 'tc', name: '顶部中', x: (1 - W) / 2, y: M, w: W, h: H * 1.35 },
      { key: 'cc', name: '正中', x: (1 - W * 1.4) / 2, y: (1 - H * 1.4) / 2, w: W * 1.4, h: H * 1.4 },
    ];
    return list;
  }

  /**
   * 在单张图上评估某个候选区。
   * 同时算「超阈残差」和「负残差」—— 有些水印是深色的（压暗），要两个方向都看。
   */
  function scoreRegion(gray, back, w, h, reg) {
    const ox = Math.round(reg.x * w), oy = Math.round(reg.y * h);
    const rw = Math.max(4, Math.round(reg.w * w)), rh = Math.max(4, Math.round(reg.h * h));
    const pos = rowProfile(gray, back, w, h, ox, oy, rw, rh, 6);
    const neg = rowProfile(
      gray, back, w, h, ox, oy, rw, rh, 6,
    );
    // neg 用反向：临时反转
    let negRows = 0, negMaxRun = 0;
    for (let y = 0; y < rh; y++) {
      const sy = oy + y, base = sy * w;
      let run = 0, best = 0, hits = 0;
      for (let x = 0; x < rw; x++) {
        const sx = ox + x;
        const diff = back[base + sx] - gray[base + sx];
        if (diff > 6) { run++; hits++; if (run > best) best = run; }
        else run = 0;
      }
      if (best > negMaxRun) negMaxRun = best;
      if (hits >= 2) negRows++;
    }
    const useNeg = negMaxRun > negRows * 0 + pos.maxRun;
    const run = useNeg ? negMaxRun : pos.maxRun;
    const rowsHit = useNeg ? negRows : pos.rowsHit;
    const sign = useNeg ? -1 : 1;

    // 置信度：既要「成行」（run 足够长），又要「成片」（有多行命中）
    const minRun = Math.max(6, rw * 0.05);
    const runScore = CV.clamp((run - minRun) / (rw * 0.25), 0, 1);
    const rowScore = CV.clamp(pos.rowRatio * 2.2, 0, 1);
    const conf = 0.62 * runScore + 0.38 * rowScore;

    return {
      key: reg.key, name: reg.name,
      region: { x: reg.x, y: reg.y, w: reg.w, h: reg.h },
      px: { x: ox, y: oy, w: rw, h: rh },
      run, rowsHit, sign, conf,
      minRun,
      meanDiff: pos.meanDiff, stdDiff: pos.stdDiff,
      maxRun: pos.maxRun,
    };
  }

  /**
   * 一张图的完整探测：返回按置信度排序的候选区（含是否建议处理的标记）。
   * 判据（数字基线，写出即断言）：
   *   conf >= 0.45  且  run >= max(6, 区域宽 5%)
   * 才对用户「建议处理」。
   */
  function detect(img, opts) {
    const o = opts || {};
    const w = img.width, h = img.height;
    const gray = luma(img);
    const back = upBackground(gray, w, h, o.cell);
    const regs = candidateRegions(w / h);
    const scored = regs.map((r) => scoreRegion(gray, back, w, h, r));
    scored.sort((a, b) => b.conf - a.conf);
    const best = scored[0];
    const suggest = !!(best && best.conf >= 0.45 && best.run >= best.minRun);
    return {
      width: w, height: h,
      candidates: scored,
      best: best ? best.key : null,
      suggest,
      confidence: best ? best.conf : 0,
    };
  }

  /** 多图探测后投票：整批图水印通常在同一个位置 */
  function vote(candidatesPerImage) {
    const tally = new Map();
    let n = 0;
    for (const det of candidatesPerImage) {
      if (!det) continue;
      n++;
      const b = det.candidates[0];
      if (!b) continue;
      const cur = tally.get(b.key) || { key: b.key, name: b.name, count: 0, conf: 0 };
      cur.count += 1;
      cur.conf += b.conf;
      tally.set(b.key, cur);
    }
    const arr = Array.from(tally.values())
      .map((t) => ({ ...t, ratio: n ? t.count / n : 0, avgConf: t.count ? t.conf / t.count : 0 }))
      .sort((a, b) => (b.count - a.count) || (b.avgConf - a.avgConf));
    return arr;
  }

  return {
    luma, medianFilter, upBackground, rowProfile,
    candidateRegions, scoreRegion, detect, vote,
  };
});

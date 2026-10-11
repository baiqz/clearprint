/*!
 * ClearPrint · app.js — 主控
 *
 * ★ 模块间数据契约（只允许一个定义点，改名前先全局搜 clearprint）
 *   item = {
 *     id, name, path, file, url,          // 基本信息
 *     w, h,                                // 原图尺寸
 *     bitmap       : ImageBitmap           // 用于显示与送进 Worker
 *     mask         : { data:Uint8ClampedArray, w:number, h:number } | null
 *                    ★ 相对原图分辨率的完整掩码；消费端在 runOne() / worker 里
 *     status       : 'wait'|'run'|'ok'|'bad'
 *     result       : Blob | null
 *     outUrl       : string | null
 *     mode         : string                 // 实际用了哪条通路
 *     error        : string
 *   }
 *   模板 template = { data:Uint8ClampedArray, w, h }  ← 与 mask 同构，可直接套用
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- 状态
  const state = {
    items: [],
    cur: -1,
    template: null,
    processing: false,
    cancel: false,
    modelReady: false,
    modelError: '',
    concurrency: 2,
    worker: null,
    pending: new Map(),
    seq: 0,
  };

  const editor = {
    canvas: null, ctx: null, maskCanvas: null, ctx2: null,
    brush: 34, drawing: false, last: null, dirty: false,
    undo: [], view: 'edit', tool: 'brush',       // tool: 'brush' | 'erase'
  };

  // ---------------------------------------------------------------- 工具

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }

  function showModal(title, html) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = html;
    $('modal').hidden = false;
  }

  const IMAGE_RE = /\.(jpe?g|png|webp|bmp|gif|avif)$/i;

  /**
   * ★ 「细节补充强度」预设。
   *
   * 背景：AI 输出是 512×512 上采回来的，天然偏软。旧版回贴会把**整个 ROI 方块**
   * 换成这份软输出（实测 ROI=753 时纹理只剩 44%），等于修 1% 的水印、糊掉一半的图。
   * 现在改成三段式回贴（核心区用 AI / 融合带 AI+原图高频 / 带外不动），
   * 这个预设就是调节「补多少上下文、锐化多强」。
   *
   *  - contextMargin：ROI 外扩比例（相对水印长边）。
   *      ★ 这里有个反直觉的坑，实测踩过：**外扩越大 ≠ 效果越好**。
   *        因为输入恒为 512²，ROI 越大缩得越狠，细节丢得越多。
   *        实测（2048×1536、水印 381×91）：ctx 0.45 → ROI 747 → AI 缩放 0.69x → 窗口锐度 1.945；
   *        ctx 0.25 → ROI 595 → 0.86x → 2.043；ctx 0.15 → ROI 519 → 0.99x → 2.196。
   *        所以「强」档是**收紧** ROI，把 512 的像素预算集中花在水印周围，而不是放更大。
   *  - band：融合带宽度(px)，防止 AI 与原图出现硬接缝。
   *  - lowRadius：取 AI 低频的模糊半径，越小保留的 AI 结构越多。
   *  - detailGain：把原图高频叠回 AI 的强度，越大越锐（也越容易在纯色区起噪）。
   */
  const DETAIL_PRESETS = {
    off:     { contextMargin: 0.25, band: 12, lowRadius: 3, detailGain: 0.0 },
    normal:  { contextMargin: 0.25, band: 12, lowRadius: 3, detailGain: 0.85 },
    strong:  { contextMargin: 0.15, band: 14, lowRadius: 2, detailGain: 1.0 },
  };

  function detailPreset() {
    const el = document.getElementById('detailLevel');
    const lv = el ? el.value : 'normal';
    return DETAIL_PRESETS[lv] || DETAIL_PRESETS.normal;
  }

  function baseName(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  // ---------------------------------------------------------------- Worker

  /**
   * ★★ 环境自检：file:// 下整个应用都跑不起来，而且报错极难懂。
   *
   * 老铁真实踩到（截图）：
   *   "Failed to construct 'Worker': Script at
   *    'file:///E:/.../js/clear-worker.js?base=%2FE%2Fworkbuudyspce2%2Fclearprint%2F'
   *    cannot be accessed from origin 'null'."
   * 状态栏「成功 0 · 失败 1 · 用时 0.1s」—— 0.1s 说明连 Worker 都没建起来。
   *
   * 为什么会这样（两个坑叠一起）：
   *   ① file:// 的 origin 是 'null'，浏览器**禁止**从 null origin 构造 Worker；
   *   ② 我们把 base 从 `location.pathname` 推导出来，而 file:// 下 pathname 是
   *      **整个真实磁盘路径**（/E:/workbuudyspce2/clearprint/index.html），
   *      于是 base 变成了 %2FE%2F... 这种鬼东西，把错误信息搅得更难读。
   *
   * 所以这里不再依赖 pathname，而是**显式判定协议**，并在 file:// 下：
   *   - 顶部给一条醒目的横幅，写清「怎么改」；
   *   - 直接锁住「开始处理」，不让人白等一场必然的失败。
   */
  const IS_FILE = (location.protocol === 'file:');

  function basePath() {
    // http(s) 下 pathname 就是站内路径，可以安全推导
    if (!IS_FILE) return location.pathname.replace(/[^/]*$/, '');
    // file:// 下没有任何可用的站内路径 —— 返回根，反正下面会拦住不让跑
    return '/';
  }

  function showFileProtocolBanner() {
    if (!IS_FILE) return;
    const el = document.createElement('div');
    el.className = 'filewarn';
    el.innerHTML =
      '<b>现在是用「双击 index.html」打开的，功能跑不起来</b>' +
      '<p>浏览器不允许 <code>file://</code> 页面创建 Worker、也读不到 AI 模型，' +
      '所以点「开始处理」必然失败。</p>' +
      '<p class="fw-how"><b>正确打开方式：</b>在项目目录执行 <code>python serve.py</code>，' +
      '然后用浏览器打开 <code>http://127.0.0.1:8788</code>。</p>';
    document.body.insertBefore(el, document.body.firstChild);
  }

  function ensureWorker() {
    if (state.worker) return state.worker;
    // file:// 下构造 Worker 必然被拒（origin 'null'），给出可读原因而不是让浏览器抛原始报错
    if (IS_FILE) {
      throw new Error(
        '当前是 file:// 直接打开的页面，浏览器不允许它创建处理线程、也读不到 AI 模型。' +
        '请改用 python serve.py 启动，再打开 http://127.0.0.1:8788');
    }
    // ★ 把 base 路径带进 Worker（importScripts 需要绝对路径，Worker 里没有 document）
    const base = basePath();
    const w = new Worker('js/clear-worker.js?base=' + encodeURIComponent(base));
    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'ready') {
        state.modelReady = true;
        state.modelError = '';
        setEngine('ok', 'AI 引擎就绪' + (m.source ? '（' + m.source + '）' : ''));
        if (state._modelWaiter) state._modelWaiter();
        return;
      }
      if (m.type === 'progress' && m.id === 'init') {
        setEngine('wait', initProgressText(m));
        return;
      }
      const p = state.pending.get(m.id);
      if (m.type === 'progress') { if (p && p.onProgress) p.onProgress(m); return; }
      if (m.type === 'done') { state.pending.delete(m.id); if (p) p.resolve(m); return; }
      if (m.type === 'error') {
        state.pending.delete(m.id);
        if (m.id === 'init') {
          // ★ 把真实原因留下来：它会被 runBatch / 失败面板展示成一条可读结论
          state.modelReady = false;
          state.modelError = m.message || '模型加载失败';
          setEngine('bad', 'AI 引擎不可用');
          if (state._modelWaiter) state._modelWaiter();
        }
        if (p) p.reject(new Error(m.message || '未知错误')); else console.error('[worker]', m.message);
        return;
      }
    };
    w.onerror = (e) => {
      // ★ Worker 挂了不能让 Promise 永远悬着：全部拒掉，给出可读原因。
      //   旧版这里只改徽标，结果所有在途图片永远停在「处理中」。
      const msg = 'AI 引擎进程出错：' + ((e && e.message) || '脚本加载失败') +
        '。请刷新页面重试。';
      state.modelReady = false;
      state.modelError = msg;
      setEngine('bad', 'AI 引擎出错');
      for (const [, p] of state.pending) { try { p.reject(new Error(msg)); } catch (_) {} }
      state.pending.clear();
      if (state._modelWaiter) state._modelWaiter();
      console.error('[worker onerror]', e.message || e);
    };
    state.worker = w;
    return w;
  }

  function setEngine(kind, text) {
    const b = $('engineBadge');
    b.className = 'badge badge-' + kind;
    b.textContent = text;
  }

  /**
   * 模型加载进度文案。
   * 线上要下 199MB，只显示百分比的话用户分不清「在下」还是「卡死了」，
   * 所以带上已下载体积与来源。
   */
  function initProgressText(m) {
    const pct = m.pct || 0;
    const mb = (n) => (n / 1048576).toFixed(0);
    let t = 'AI 模型加载中 ' + pct + '%';
    if (m.bytes) t += '（' + mb(m.got || 0) + '/' + mb(m.bytes) + 'MB）';
    if (m.source && pct > 0) t += ' · ' + m.source;
    return t;
  }

  function callWorker(msg, transfer) {
    return new Promise((resolve, reject) => {
      state.pending.set(msg.id, { resolve, reject, onProgress: msg.__onProgress });
      delete msg.__onProgress;
      ensureWorker().postMessage(msg, transfer || []);
    });
  }

  // ---------------------------------------------------------------- 导入

  async function addFiles(files) {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/') || IMAGE_RE.test(f.name));
    if (!list.length) { toast('没找到图片文件'); return; }
    let skipped = 0;

    for (const f of list) {
      try {
        const bmp = await createImageBitmap(f);
        const item = {
          id: ++state.seq,
          name: f.name,
          path: f.webkitRelativePath || f.name,
          file: f,
          w: bmp.width, h: bmp.height,
          bitmap: bmp,
          mask: null,
          status: 'wait',
          result: null, outUrl: null,
          mode: '', error: '',
        };
        state.items.push(item);
      } catch (e) {
        skipped++;
      }
    }

    if (skipped) toast(`有 ${skipped} 个文件读不出来，已跳过`);
    if (state.items.length) {
      $('cardMark').hidden = false;
      $('cardRun').hidden = false;
      if (state.cur < 0) select(0);
      else renderGrid();
      updateRunHint();
      updateButtons();
    }
  }

  // ---------------------------------------------------------------- 编辑区

  function select(i) {
    if (i < 0 || i >= state.items.length) return;
    state.cur = i;
    const it = state.items[i];

    const wrap = $('canvasWrap');
    const stage = $('cstage');
    const bc = $('baseCanvas');
    const mc = $('maskCanvas');

    // ★ 可用空间必须减去 wrap 自己的 padding（8px×2）和边框，否则算出来的
    //   尺寸比容器还宽，会被 overflow:hidden 裁掉右边（旧版「右边涂不到」的成因之一）。
    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const maxW = Math.max(200, wrap.clientWidth - padX);
    const maxH = Math.max(200, Math.min(window.innerHeight - 320, 620) - padY);
    const scale = Math.min(maxW / it.w, maxH / it.h, 1);
    const dw = Math.max(1, Math.round(it.w * scale));
    const dh = Math.max(1, Math.round(it.h * scale));

    // canvas 位图分辨率 = 显示尺寸（1:1 像素，涂抹所见即所得）
    bc.width = dw; bc.height = dh;
    mc.width = dw; mc.height = dh;
    // ★ .stage 是唯一的尺寸定义点：它同时约束两张 canvas（CSS 里 canvas 宽高 100%）
    stage.style.width = dw + 'px';
    stage.style.height = dh + 'px';

    const ctx = bc.getContext('2d');
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(it.bitmap, 0, 0, dw, dh);

    // 恢复该图的掩码（若有）；尺寸不一致时按相对比例放大回来
    const ctx2 = mc.getContext('2d');
    ctx2.clearRect(0, 0, dw, dh);
    if (it.mask) {
      let m = it.mask;
      if (!maskMatches(it, m)) {
        const d = CV.dims(m);
        m = CV.scaleMask(m, it.w, it.h);
      }
      drawMaskToCanvas(m, ctx2, dw, dh);
    } else if (state.template && $('applyAll').checked) {
      const m = maskMatches(it, state.template) ? state.template : CV.scaleMask(state.template, it.w, it.h);
      drawMaskToCanvas(m, ctx2, dw, dh);
    }

    editor.canvas = bc; editor.ctx = ctx;
    editor.maskCanvas = mc; editor.ctx2 = ctx2;
    mc.classList.toggle('eraser', editor.tool === 'erase');
    editor.undo = [];
    editor.dirty = !!it.mask;

    $('canvasEmpty').hidden = true;
    $('stageName').textContent = it.name;
    $('stageIdx').textContent = (i + 1) + ' / ' + state.items.length;
    if (it.result && it.outUrl) showView('after');
    else showView(editor.view === 'after' ? 'edit' : editor.view);

    // 把显示结果换成「原图」时也要复位
    renderGrid();
    updateButtons();
  }

  /** 窗口尺寸变化时重排当前图（保持涂抹不丢：掩码是原图分辨率，重排后再画一遍） */
  let relayoutTimer = null;
  function relayoutCurrent() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      if (editor.view !== 'edit' || state.cur < 0) return;
      const it = state.items[state.cur];
      if (!it || !editor.dirty) return;
      commitMask();          // 落盘当前涂抹，避免重排丢失
      select(state.cur);     // 重排（select 会按 it.mask 重绘掩码）
    }, 140);
  }

  /**
   * 把掩码画成半透明红层。
   * ★ 掩码结构有两个来源，字段名不同，这里统一入口：
   *   - CV.newMask() 产出 { data, width, height }
   *   - state.template / it.mask（模板套用路径）产出 { data, w, h }
   * 只允许这一处做归一化，别在调用点各写各的。
   */
  function maskDims(mask) {
    const w = mask.w != null ? mask.w : mask.width;
    const h = mask.h != null ? mask.h : mask.height;
    return { w, h };
  }

  function drawMaskToCanvas(mask, ctx, dw, dh) {
    const { w, h } = maskDims(mask);
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    const id = octx.createImageData(w, h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const v = mask.data[i];
      id.data[p] = 255; id.data[p + 1] = 59; id.data[p + 2] = 48;
      id.data[p + 3] = Math.round(v * 0.42);           // 半透明红覆盖
    }
    octx.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, dw, dh);
  }

  /** 掩码是否与图片同尺寸（不同则需换算法处理） */
  function maskMatches(item, mask) {
    const { w, h } = maskDims(mask);
    return w === item.w && h === item.h;
  }

  /** 编辑画布坐标 → 原图坐标 */
  function canvasToImage(cx, cy) {
    const it = state.items[state.cur];
    const r = editor.maskCanvas.getBoundingClientRect();
    const sx = it.w / r.width, sy = it.h / r.height;
    return { x: (cx - r.left) * sx, y: (cy - r.top) * sy, s: sx };
  }

  /** 画布上的红层 → 原图分辨率的掩码 */
  function readMaskFromCanvas() {
    const it = state.items[state.cur];
    const mc = editor.maskCanvas;
    const off = document.createElement('canvas');
    off.width = mc.width; off.height = mc.height;
    const octx = off.getContext('2d');
    octx.drawImage(mc, 0, 0);
    const px = octx.getImageData(0, 0, mc.width, mc.height).data;
    // 缩回原图分辨率：先在画布分辨率上二值化，再缩放
    const small = CV.mask(mc.width, mc.height);
    for (let i = 0, p = 0; i < small.data.length; i++, p += 4) {
      small.data[i] = px[p + 3] > 40 ? 255 : 0;
    }
    if (mc.width === it.w && mc.height === it.h) return small;
    return CV.scaleMask(small, it.w, it.h);
  }

  function commitMask() {
    const it = state.items[state.cur];
    if (!it) return;
    const m = readMaskFromCanvas();
    it.mask = CV.hasMask(m) ? m : null;
    editor.dirty = !!it.mask;
    updateButtons();
  }

  // ---------------------------------------------------------------- 绘制事件

  function bindPainting() {
    const mc = () => editor.maskCanvas;

    const start = (e) => {
      if (!editor.maskCanvas || editor.view !== 'edit') return;
      const it = state.items[state.cur];
      if (!it) return;
      editor.undo.push(readMaskFromCanvas());
      if (editor.undo.length > 24) editor.undo.shift();
      editor.drawing = true;
      const p = canvasToImage(e.clientX, e.clientY);
      editor.last = p;
      paintAt(e.clientX, e.clientY);
      // setPointerCapture 在「合成事件 / 指针已释放」时会抛 InvalidPointerId，
      // 不影响绘制本身，但不能让它冒到全局。
      try {
        if (editor.maskCanvas.setPointerCapture) editor.maskCanvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      e.preventDefault();
    };
    const move = (e) => {
      if (!editor.drawing) return;
      const p = canvasToImage(e.clientX, e.clientY);
      const l = editor.last;
      // 补间：鼠标快速移动时不能断成点
      const dist = Math.hypot(p.x - l.x, p.y - l.y);
      const step = Math.max(1, Math.floor(dist / (p.s * editor.brush * 0.35)));
      for (let k = 1; k <= step; k++) {
        const t = k / step;
        stampAt(l.x + (p.x - l.x) * t, l.y + (p.y - l.y) * t);
      }
      editor.last = p;
      e.preventDefault();
    };
    const end = (e) => {
      if (!editor.drawing) return;
      editor.drawing = false;
      commitMask();
      renderGrid();
      if (e && e.pointerId != null && editor.maskCanvas) {
        try { editor.maskCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    };

    document.addEventListener('pointerdown', (e) => {
      if (e.target === mc()) start(e);
    }, true);
    document.addEventListener('pointermove', (e) => {
      if (editor.drawing) move(e);
    }, true);
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
  }

  function stampAt(ix, iy) {
    const it = state.items[state.cur];
    if (!it || !editor.maskCanvas) return;
    const r = editor.maskCanvas.getBoundingClientRect();
    const sx = r.width / it.w, sy = r.height / it.h;
    const cx = ix * sx, cy = iy * sy;
    const rad = editor.brush * sx;
    const c = editor.ctx2;
    const er = editor.tool === 'erase';
    // ★ 橡皮用 globalCompositeOperation='destination-out' 真正挖掉 alpha，
    //   不能靠填白/填透明色 —— maskCanvas 的 alpha 通道就是掩码本身。
    c.save();
    if (er) c.globalCompositeOperation = 'destination-out';
    c.fillStyle = er ? '#000' : '#ff3b30';
    c.globalAlpha = er ? 1 : 0.42;
    c.beginPath();
    c.arc(cx, cy, Math.max(1.2, rad), 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function paintAt(clientX, clientY) {
    const it = state.items[state.cur];
    if (!it) return;
    const p = canvasToImage(clientX, clientY);
    stampAt(p.x, p.y);
  }

  // ---------------------------------------------------------------- 快速框选

  function quadSelect(key) {
    const it = state.items[state.cur];
    if (!it) { toast('先导入图片'); return; }
    editor.undo.push(readMaskFromCanvas());
    const c = editor.ctx2;
    const dw = editor.maskCanvas.width, dh = editor.maskCanvas.height;
    c.fillStyle = '#ff3b30';
    c.globalAlpha = 0.42;
    const W = 0.34, H = 0.14, M = 0.012;
    const R = {
      tl: [M, M, W, H], tr: [1 - M - W, M, W, H],
      bl: [M, 1 - M - H, W, H], br: [1 - M - W, 1 - M - H, W, H],
      bc: [(1 - W) / 2, 1 - M - H * 1.35, W, H * 1.35],
      cc: [(1 - W * 1.4) / 2, (1 - H * 1.4) / 2, W * 1.4, H * 1.4],
    }[key];
    if (!R) return;
    c.fillRect(R[0] * dw, R[1] * dh, R[2] * dw, R[3] * dh);
    c.globalAlpha = 1;
    commitMask();
    renderGrid();
    toast('已框选，可继续微调');
  }

  // ---------------------------------------------------------------- 自动探测

  function detectOnCurrent() {
    const it = state.items[state.cur];
    if (!it) { toast('先导入图片'); return; }
    const t0 = performance.now();
    const c = document.createElement('canvas');
    // 探测不需要原分辨率，缩到 640 宽足够（提速十几倍）
    const s = Math.min(1, 640 / it.w);
    c.width = Math.max(2, Math.round(it.w * s));
    c.height = Math.max(2, Math.round(it.h * s));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(it.bitmap, 0, 0, c.width, c.height);
    const im = ctx.getImageData(0, 0, c.width, c.height);
    const det = WIPE.detect({ data: im.data, width: c.width, height: c.height }, {});
    const dt = Math.round(performance.now() - t0);

    const box = $('detectResult');
    const rows = det.candidates.slice(0, 4).map((cd) => {
      const cls = cd.conf >= 0.45 ? 'hot' : (cd.conf >= 0.22 ? 'warm' : '');
      const pct = Math.round(cd.conf * 100);
      return `<div class="${cls}"><span class="dot"></span>${cd.name} · 置信 ${pct}% · 最长笔画 ${cd.run}px</div>`;
    }).join('');
    box.innerHTML = rows + `<div style="color:#8b94a5;margin-top:4px">耗时 ${dt}ms</div>`;

    const best = det.candidates[0];
    if (det.suggest && best) {
      // 把候选区转成掩码
      const { x, y, w, h } = best.region;
      const m = CV.newMask(it.w, it.h);
      CV.fillRect(m, x * it.w, y * it.h, w * it.w, h * it.h);
      it.mask = m;
      editor.undo.push(readMaskFromCanvas());
      const cx2 = editor.ctx2;
      cx2.clearRect(0, 0, editor.maskCanvas.width, editor.maskCanvas.height);
      drawMaskToCanvas(m, cx2, editor.maskCanvas.width, editor.maskCanvas.height);
      editor.dirty = true;
      renderGrid();
      updateButtons();
      toast(`探测到「${best.name}」水印，已框选`);
    } else {
      toast('没探测到明显水印，请手动涂抹');
    }
  }

  // ---------------------------------------------------------------- 批量

  function updateButtons() {
    const it = state.items[state.cur];
    const hasMask = it ? !!it.mask : false;
    const tpl = $('applyAll').checked && !!state.template;
    $('btnRun').disabled = IS_FILE || !state.items.length || !(hasMask || tpl) || state.processing;
    $('btnPreview').disabled = !state.items.length || state.processing;
    $('btnZip').disabled = state.processing || !state.items.some((x) => x.result);
    const nBad = state.items.filter((x) => x.status === 'bad').length;
    $('btnRetry').hidden = !nBad || state.processing;
    $('btnRetry').textContent = `重试失败项（${nBad}）`;
  }

  function updateRunHint() {
    const n = state.items.length;
    const withMask = state.items.filter((x) => x.mask).length;
    $('runHint').textContent = state.template
      ? `共 ${n} 张 · 将按模板处理`
      : `共 ${n} 张 · 已标注 ${withMask} 张`;
  }

  function saveTemplate() {
    const it = state.items[state.cur];
    if (!it || !it.mask) { toast('这张还没有涂抹'); return false; }
    // ★ 模板与 it.mask 完全同构（都用 CV.mask 构造，带 w/h 双别名），可直接互换
    const d = CV.dims(it.mask);
    state.template = CV.mask(d.width, d.height, new Uint8ClampedArray(it.mask.data));
    // 同时把掩码记到所有未标注的图上，保证「涂一张 → 批量」真的生效
    for (const x of state.items) {
      if (!x.mask) x.mask = CV.mask(d.width, d.height, new Uint8ClampedArray(it.mask.data));
    }
    updateRunHint();
    renderGrid();
    updateButtons();
    toast(`已套用到全部 ${state.items.length} 张`);
    return true;
  }

  function clearAll() {
    for (const x of state.items) {
      x.mask = null; x.status = 'wait'; x.result = null;
      if (x.outUrl) { URL.revokeObjectURL(x.outUrl); x.outUrl = null; }
      x.mode = ''; x.error = '';
    }
    state.template = null;
    editor.undo = [];
    editor.dirty = false;
    if (editor.ctx2) editor.ctx2.clearRect(0, 0, editor.maskCanvas.width, editor.maskCanvas.height);
    renderGrid(); updateRunHint(); updateButtons();
  }

  async function runOne(it, idx) {
    // ★ 消费端契约校验：字段名错了要给可读错误，别让 TypeError 冒到 UI
    if (!it.mask || !it.mask.data || !it.mask.data.length) {
      throw new Error('这张没有掩码：请先涂抹或套用模板');
    }
    const mode = document.querySelector('input[name=mode]:checked').value;
    const fmt = $('fmt').value;

    // ★ 送进 Worker 的位图必须是【一次性的】—— 它会被 transfer 走（detach）。
    //   绝不能把 it.bitmap（编辑器/缩略图还要用）直接递出去：
    //   一旦 createImageBitmap 失败走了 it.bitmap 兜底，再把 it.bitmap 传走，
    //   主线程的 it.bitmap 就废了，后续 select()/renderTile() 全炸。
    let bmp = null;
    try {
      bmp = await createImageBitmap(it.file);
    } catch (e) {
      // 兜底：从 it.bitmap 复制一张一次性的（不转移原图）
      try {
        const c = document.createElement('canvas');
        c.width = it.w; c.height = it.h;
        c.getContext('2d').drawImage(it.bitmap, 0, 0, it.w, it.h);
        bmp = await createImageBitmap(c);
      } catch (e2) {
        throw new Error('这张图片读不出来（' + ((e && e.message) || e) + '），请重新导入');
      }
    }

    const res = await callWorker({
      type: 'run',
      id: 'r' + it.id + '-' + idx,
      bitmap: bmp,
      mask: { data: it.mask.data, w: it.mask.w, h: it.mask.h },
      opts: {
        mode,
        format: fmt,
        quality: 0.94,
        dilate: 2,
        maskFeather: 2,
        margin: 0.75,
        alpha: { medianK: 41, alphaGain: 1.0 },
        alphaMaxResidual: 6,
        lama: { featherBefore: true, ...detailPreset() },
      },
    }, [bmp]);

    it.result = res.blob;
    if (it.outUrl) URL.revokeObjectURL(it.outUrl);
    it.outUrl = URL.createObjectURL(res.blob);
    it.mode = res.mode;
    it.alpha = res.alpha;
    it.status = 'ok';
    it.error = '';
    return res;
  }

  /**
   * ★★ 批量处理。老铁踩过的坑全在这里：
   *
   *   症状：点「开始处理」后 19 张瞬间全红，状态栏「成功 0 · 失败 19 · 用时 0.0s」，
   *        引擎徽标还停在「引擎加载中…」。
   *   根因：他的素材是【半透明白字水印 + 透明背景 PNG】→ α 反解判不了（饱和）→
   *        auto 全部转 LaMa；而 198MB 模型还没下载完 → Worker 里每张图各抛一次
   *        「模型未就绪，无法使用 AI 修复」→ 19 张各记一条同样的错。
   *
   *   三条修正：
   *   ① 【进批前预检】要 LaMa 而模型没就绪 → 不开工。要么等（带进度），要么明确告诉用户怎么办。
   *   ② 【同一原因只报一次】失败原因去重，19 张重复的压成一条结论 + 一份清单。
   *   ③ 【致命错误直接中止】模型级故障不可能是「这张图的问题」，
   *      继续跑只会把整批标红、把真实原因埋掉。
   */
  async function runBatch(onlyCurrent) {
    if (state.processing) return;
    const targets = onlyCurrent ? [state.cur] : state.items.map((_, i) => i);
    const withMask = targets.filter((i) => state.items[i].mask);
    if (!withMask.length) {
      toast($('applyAll').checked ? '请先在图上涂抹一处水印' : '请先涂抹，或勾选「套用到全部」');
      return;
    }

    const mode = document.querySelector('input[name=mode]:checked').value;

    // ---- 预检 ①：明确要 AI 修复，但引擎没就绪 ----
    if (mode === 'lama' && !state.modelReady) {
      setEngine('wait', '正在加载 AI 模型…');
      toast('AI 模型还在加载（首次约 198MB），等它就绪后会自动开始…', 5200);
      const okReady = await waitModel(90000);
      if (!okReady) {
        return finishFailAll(withMask, state.modelError ||
          'AI 修复模型没能加载成功。可先改用「半透明水印还原」，或刷新页面重试。');
      }
    }

    state.processing = true;
    state.cancel = false;
    $('btnCancel').hidden = false;
    $('pbar').hidden = false;
    $('failBox').hidden = true;
    updateButtons();

    let done = 0, ok = 0, bad = 0;
    const total = withMask.length;
    const queue = withMask.slice();
    const t0 = performance.now();
    const fails = new Map();          // 原因 → [文件名…]
    let fatal = null;                 // 模型级故障：中止后续

    const tick = () => {
      const pct = Math.round((done / total) * 100);
      $('pbarFill').style.width = pct + '%';
      const el = ((performance.now() - t0) / 1000).toFixed(1);
      $('pstat').textContent = `已完成 ${done}/${total} · 成功 ${ok} · 失败 ${bad} · 用时 ${el}s`;
    };
    tick();

    const worker = async () => {
      while (queue.length && !state.cancel && !fatal) {
        const i = queue.shift();
        const it = state.items[i];
        it.status = 'run';
        renderTile(i);
        try {
          await runOne(it, i);
          ok++;
        } catch (e) {
          const reason = (e && (e.message || String(e))) || 'unknown';
          it.status = 'bad';
          it.error = reason;
          bad++;
          if (!fails.has(reason)) fails.set(reason, []);
          fails.get(reason).push(it.name);
          console.error('[run]', it.name, e);
          // ★ 模型级故障：不是这张图的问题，再跑下去只会把整批标红
          if (/模型|AI 修复模型|不支持的浏览器|图片位图不可用/.test(reason)) fatal = reason;
        }
        done++;
        renderTile(i);
        tick();
      }
    };
    const n = Math.max(1, Math.min(state.concurrency, total));
    await Promise.all(Array.from({ length: n }, worker));

    // 被 fatal 中止的：剩下的标记为「待处理」，而不是假的「失败」
    if (fatal) {
      for (const i of queue) { state.items[i].status = 'wait'; renderTile(i); }
    }

    state.processing = false;
    $('btnCancel').hidden = true;
    const el = ((performance.now() - t0) / 1000).toFixed(1);
    $('pstat').textContent = fatal
      ? `已中止 · 成功 ${ok} · 失败 ${bad} · 剩余 ${queue.length} 张未处理（用时 ${el}s）`
      : (state.cancel
        ? `已停止 · 完成 ${done}/${total}`
        : `全部完成 · 成功 ${ok} · 失败 ${bad} · 用时 ${el}s`);
    updateButtons();

    if (bad) showFailures(fails, fatal, queue.length);
    else if (!state.cancel) toast(`处理完成，共 ${ok} 张`);

    const cur = state.items[state.cur];
    if (cur && cur.result) showView('after');
  }

  /** 等模型就绪（带超时）。返回是否真的就绪。 */
  function waitModel(timeoutMs) {
    if (state.modelReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const iv = setInterval(() => {
        if (state.modelReady) { cleanup(); resolve(true); }
      }, 400);
      timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      function cleanup() { clearInterval(iv); clearTimeout(timer); }
      state._modelWaiter = cleanup;
    });
  }

  /** 一个原因一条：把「19 张同一个错」压成一条结论，并列出文件名。 */
  function showFailures(fails, fatal, left) {
    const box = $('failBox');
    const rows = [...fails.entries()].map(([reason, names]) => {
      const list = names.slice(0, 8).join('、') + (names.length > 8 ? ` 等 ${names.length} 张` : '');
      return `<li><b>${escapeHtml(reason)}</b><div class="fx">${escapeHtml(list)}</div></li>`;
    }).join('');
    const head = fatal
      ? `<p class="fh">已中止处理：这是<b>引擎级</b>故障（不是某张图的问题），
           剩余 ${left} 张未动。修好原因后点「重试失败项」即可继续。</p>`
      : `<p class="fh">有 ${[...fails.values()].reduce((a, b) => a + b.length, 0)} 张失败。</p>`;
    box.innerHTML = head + `<ul class="flist">${rows}</ul>`;
    box.hidden = false;
  }

  /** 整批都没能开始（预检就挂了）：给一次结论，不逐张标红。 */
  function finishFailAll(idxs, reason) {
    const names = idxs.map((i) => state.items[i].name);
    const fails = new Map([[reason, names]]);
    showFailures(fails, reason, 0);
    $('pstat').textContent = `未开始 · ${names.length} 张待处理`;
    updateRunHint();
    updateButtons();
    toast(reason, 6000);
  }

  /** 重试失败项：清掉失败态，重跑（模型级故障会先重置模型）。 */
  async function retryFailed() {
    if (state.processing) return;
    const idxs = state.items.map((_, i) => i).filter((i) => state.items[i].status === 'bad');
    if (!idxs.length) { toast('没有失败的图片'); return; }
    // 模型级故障：先让 Worker 忘掉失败态，允许重新加载一次
    const anyModelErr = idxs.some((i) => /模型/.test(state.items[i].error || ''));
    if (anyModelErr) {
      state.modelReady = false;
      state.modelError = '';
      setEngine('wait', '重新加载 AI 模型…');
      try { ensureWorker().postMessage({ type: 'resetModel' }); } catch (_) {}
    }
    for (const i of idxs) {
      const it = state.items[i];
      it.status = 'wait'; it.error = '';
    }
    renderGrid();
    $('failBox').hidden = true;
    await runBatch(false);
  }

  // ---------------------------------------------------------------- 渲染

  function renderTile(i) {
    const it = state.items[i];
    const el = document.querySelector(`.tile[data-i="${i}"]`);
    if (!el) { renderGrid(); return; }
    const img = el.querySelector('.tile-img');
    if (it.outUrl) { if (img.src !== it.outUrl) img.src = it.outUrl; }
    else if (img.dataset.orig !== '1') {
      const c = document.createElement('canvas');
      const s = 172 / Math.max(it.w, it.h);
      c.width = Math.max(2, Math.round(it.w * s));
      c.height = Math.max(2, Math.round(it.h * s));
      c.getContext('2d').drawImage(it.bitmap, 0, 0, c.width, c.height);
      img.src = c.toDataURL('image/jpeg', 0.8);
      img.dataset.orig = '1';
    }
    const tag = el.querySelector('.tile-tag');
    const map = {
      wait: ['t-wait', '待处理'], run: ['t-run', '处理中'],
      ok: ['t-ok', it.mode === 'alpha' ? '已还原' : '已修复'],
      bad: ['t-bad', '失败'],
    };
    const [cls, txt] = map[it.status] || map.wait;
    // ★ 失败原因直接显示在卡片上，不藏在 title 里（老铁那次只能看到「失败」两个字，
    //   原因要 hover 才可见，等于没有信息）。
    const err = (it.status === 'bad' && it.error)
      ? `<div class="tile-err" title="${escapeHtml(it.error)}">${escapeHtml(shortErr(it.error))}</div>` : '';
    tag.innerHTML = `<span class="t ${cls}">${txt}</span>` +
      (it.mask ? '<span style="color:#8b94a5">已标注</span>' : '') + err;
    el.classList.toggle('cur', i === state.cur);
  }

  function shortErr(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > 26 ? t.slice(0, 26) + '…' : t;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderGrid() {
    const g = $('grid');
    if (g.children.length !== state.items.length) {
      g.innerHTML = '';
      state.items.forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'tile';
        d.dataset.i = i;
        d.innerHTML =
          `<img class="tile-img" alt="">` +
          `<button class="tile-pick" type="button" title="编辑这张">✎</button>` +
          `<button class="tile-x" type="button" title="移除">✕</button>` +
          `<div class="tile-meta"><div class="tile-name" title="${escapeHtml(it.path)}">${escapeHtml(it.name)}</div>` +
          `<div class="tile-tag"></div></div>`;
        d.querySelector('.tile-x').onclick = (e) => {
          e.stopPropagation();
          removeItem(i);
        };
        d.querySelector('.tile-pick').onclick = (e) => {
          e.stopPropagation();
          selectT(i);
        };
        d.onclick = () => selectT(i);
        g.appendChild(d);
      });
    }
    state.items.forEach((_, i) => renderTile(i));
  }

  function selectT(i) {
    if (i === state.cur) return;
    // 切图前先把当前涂抹落盘
    if (state.cur >= 0 && editor.dirty) commitMask();
    select(i);
  }

  function removeItem(i) {
    const it = state.items[i];
    if (it.outUrl) URL.revokeObjectURL(it.outUrl);
    state.items.splice(i, 1);
    if (!state.items.length) {
      state.cur = -1;
      $('cardMark').hidden = true;
      $('cardRun').hidden = true;
      $('grid').innerHTML = '';
      return;
    }
    state.cur = Math.min(state.cur, state.items.length - 1);
    $('grid').innerHTML = '';
    renderGrid();
    select(state.cur);
    updateRunHint();
    updateButtons();
  }

  function showView(v) {
    editor.view = v;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === v));
    const mc = $('maskCanvas');
    const bc = $('baseCanvas');
    const it = state.items[state.cur];
    mc.classList.toggle('hide', v !== 'edit');
    if (!it) return;
    const ctx = bc.getContext('2d');
    const dw = bc.width, dh = bc.height;
    ctx.clearRect(0, 0, dw, dh);
    if (v === 'after' && it.outUrl) {
      const im = new Image();
      im.onload = () => { ctx.clearRect(0, 0, dw, dh); ctx.drawImage(im, 0, 0, dw, dh); };
      im.src = it.outUrl;
    } else {
      ctx.drawImage(it.bitmap, 0, 0, dw, dh);
    }
  }

  // ---------------------------------------------------------------- 打包

  async function exportZip() {
    const done = state.items.filter((x) => x.result);
    if (!done.length) { toast('还没有处理好的图片'); return; }
    const fmt = $('fmt').value;
    const ext = fmt === 'png' ? '.png' : '.jpg';
    const used = new Map();
    const entries = done.map((it) => {
      let base = baseName(it.name) + '-clean' + ext;
      const n = used.get(base) || 0;
      used.set(base, n + 1);
      if (n) base = baseName(it.name) + '-clean-' + (n + 1) + ext;
      return { name: base, data: it.result };
    });
    $('pstat').textContent = '正在打包…';
    try {
      const blob = await ZIP.build(entries, (p, nm) => {
        $('pstat').textContent = `打包中 ${Math.round(p * 100)}% · ${nm}`;
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'clearprint-' + new Date().toISOString().slice(0, 10) + '.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      $('pstat').textContent = `打包完成：${entries.length} 个文件`;
      toast('ZIP 已开始下载');
    } catch (e) {
      console.error(e);
      $('pstat').textContent = '打包失败：' + e.message;
      toast('打包失败');
    }
  }

  // ---------------------------------------------------------------- 绑定

  function bindUI() {
    $('btnPickFiles').onclick = () => $('fileInput').click();
    $('btnPickFolder').onclick = () => $('dirInput').click();
    $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
    $('dirInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

    const drop = $('drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.remove('over');
    }));
    drop.addEventListener('drop', async (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const files = [];
      if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
        const entries = [];
        for (const it of dt.items) {
          const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
          if (en) entries.push(en);
        }
        for (const en of entries) await walkEntry(en, files);
      } else {
        for (const f of dt.files) files.push(f);
      }
      addFiles(files);
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    $('btnPrev').onclick = () => selectT(Math.max(0, state.cur - 1));
    $('btnNext').onclick = () => selectT(Math.min(state.items.length - 1, state.cur + 1));
    $('brush').oninput = (e) => { editor.brush = +e.target.value; $('brushVal').textContent = e.target.value; };

    // 涂抹工具切换（画笔 / 橡皮）
    function setTool(t) {
      editor.tool = t;
      const isErase = t === 'erase';
      $('btnBrush').classList.toggle('on', !isErase);
      $('btnEraser').classList.toggle('on', isErase);
      if (editor.maskCanvas) editor.maskCanvas.classList.toggle('eraser', isErase);
      $('brushTip').innerHTML = isErase
        ? '切到<b>橡皮</b>，涂过的地方会擦掉（可反复修改）'
        : '在图上<b>按住拖动</b>即可涂抹水印位置';
    }
    $('btnBrush').onclick = () => setTool('brush');
    $('btnEraser').onclick = () => setTool('erase');

    $('btnDetect').onclick = detectOnCurrent;
    $('btnClearMask').onclick = () => {
      if (!editor.ctx2) return;
      editor.undo.push(readMaskFromCanvas());
      editor.ctx2.clearRect(0, 0, editor.maskCanvas.width, editor.maskCanvas.height);
      commitMask(); renderGrid();
      toast('已清空涂抹');
    };
    $('btnUndo').onclick = () => {
      const prev = editor.undo.pop();
      if (!prev) { toast('没有可撤销的了'); return; }
      const it = state.items[state.cur];
      it.mask = CV.hasMask(prev) ? prev : null;
      editor.ctx2.clearRect(0, 0, editor.maskCanvas.width, editor.maskCanvas.height);
      if (it.mask) drawMaskToCanvas(it.mask, editor.ctx2, editor.maskCanvas.width, editor.maskCanvas.height);
      editor.dirty = !!it.mask;
      renderGrid(); updateButtons();
    };
    document.querySelectorAll('.quad button').forEach((b) => {
      b.onclick = () => quadSelect(b.dataset.quad);
    });
    document.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => showView(t.dataset.view);
    });
    $('applyAll').onchange = () => {
      if ($('applyAll').checked) {
        const it = state.items[state.cur];
        if (it && it.mask) saveTemplate();
      } else {
        state.template = null;
      }
      updateRunHint(); updateButtons();
    };
    $('btnRun').onclick = () => {
      if ($('applyAll').checked) {
        const it = state.items[state.cur];
        if (it && it.mask) saveTemplate();
      }
      runBatch(false);
    };
    $('btnPreview').onclick = () => {
      if ($('applyAll').checked) {
        const it = state.items[state.cur];
        if (it && it.mask) saveTemplate();
      }
      runBatch(true);
    };
    $('btnCancel').onclick = () => { state.cancel = true; toast('正在停止…'); };
    $('btnRetry').onclick = retryFailed;
    $('btnZip').onclick = exportZip;

    $('btnHelp').onclick = () => showModal('怎么用 ClearPrint', `
      <ol>
        <li><b>把整个文件夹拖进来</b>（或点「选择文件夹」）。子目录会一起读，层级在导出时拉平。</li>
        <li>在第一步的图上<b>涂抹水印位置</b> —— 涂得比水印稍微大一圈，AI 才不会在边缘留鬼影。
          也可以用「自动探测」或「快速框选」。</li>
        <li>点<b>「套用到全部」</b>，同一个位置的水印一次搞定；不勾就只处理涂过的那几张。</li>
        <li>选处理方式：<b>自动</b>最省事 —— 浅色半透明水印走「还原」（快、细节不糊），
          实心水印自动切 AI 修复。</li>
        <li>点<b>开始处理</b>，跑完「打包下载 ZIP」。</li>
      </ol>
      <p><b>隐私</b>：所有计算都在你自己的浏览器里，图片一个字节都不上传。</p>
      <p><b>小贴士</b>：水印是白色/浅色半透明的（大多数平台都是），用「半透明水印还原」效果最好；
      如果是压在不规则花纹上的实心水印，用 AI 修复。</p>
    `);
    $('modalOk').onclick = () => { $('modal').hidden = true; };
    $('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').hidden = true; };

    // ★ 窗口尺寸变化 → 重排当前图（并保住在途涂抹）。
    //   旧版那行 `state.cur = -1; select(i)` 是绕开 select 的 cur 守卫，
    //   但它会丢掉未落盘的涂抹（editor.dirty）。改用 relayoutCurrent()。
    window.addEventListener('resize', relayoutCurrent);
    // 侧栏折叠 / 字体加载等改变 wrap 宽度的情况也要跟（select 依赖 clientWidth）
    if (window.ResizeObserver) {
      try {
        let lastW = $('canvasWrap').clientWidth;
        new ResizeObserver(() => {
          const w = $('canvasWrap').clientWidth;
          if (Math.abs(w - lastW) < 2) return;
          lastW = w;
          relayoutCurrent();
        }).observe($('canvasWrap'));
      } catch (_) {}
    }
  }

  async function walkEntry(entry, out) {
    if (!entry) return;
    if (entry.isFile) {
      await new Promise((res) => entry.file((f) => { f.__rel = entry.fullPath || f.name; out.push(f); res(); },
        () => res()));
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const readAll = () => new Promise((res) => {
        const acc = [];
        const step = () => reader.readEntries((ents) => {
          if (!ents.length) { res(acc); return; }
          acc.push(...ents); step();
        }, () => res(acc));
        step();
      });
      const ents = await readAll();
      for (const e of ents) await walkEntry(e, out);
    }
  }

  // ---------------------------------------------------------------- 测试钩子

  window.__cp = {
    getState: () => state,
    select: selectT,
    selectItem: (id) => {
      const i = state.items.findIndex((x) => x.id === id);
      if (i >= 0) selectT(i);
    },
    editor: () => editor,
    saveTemplate, runBatch, clearAll, exportZip, addFiles,
    retryFailed,
    detect: detectOnCurrent,
    setConcurrency: (n) => { state.concurrency = n; },
  };

  // ---------------------------------------------------------------- 启动

  function boot() {
    bindUI();
    bindPainting();

    // ★ file:// 下不要去建 Worker（浏览器会抛 origin 'null' 的原始报错，
    //   用户只能看到一串 file:/// 路径，完全不知道该怎么办）。
    //   改成：顶部横幅写清正确打开方式 + 锁住「开始处理」。
    if (IS_FILE) {
      showFileProtocolBanner();
      setEngine('bad', '需用本地服务打开');
      updateButtons();
      return;
    }

    try {
      ensureWorker().postMessage({ type: 'init' });
      setEngine('wait', '引擎加载中…');
    } catch (e) {
      // 兜底：真出意外也要让人看懂，而不是留一个空白徽标
      state.modelError = (e && e.message) || '处理线程启动失败';
      setEngine('bad', '引擎不可用');
    }
    updateButtons();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

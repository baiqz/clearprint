/*!
 * ClearPrint · clear-worker.js — 经典 Worker（非 module）
 *
 * 必须用经典 Worker + importScripts：ORT 的 wasm 构建在 module worker 下
 * 动态 import 路径容易炸（no available backend found ... Failed to fetch dynamically
 * imported module）。见技能 lama-browser-inpainting。
 *
 * 协议
 *   主 → Worker: {type:'init'}                                  ← 加载模型
 *               {type:'run', id, bitmap, mask:{data,w,h}, opts}  ← 处理一张
 *               {type:'cancel', id}
 *   Worker → 主: {type:'ready'} | {type:'progress', id, stage, pct}
 *               {type:'done', id, blob, stats} | {type:'error', id, message}
 */
'use strict';

/* 依赖注入：主线程通过 Worker 的 query string 把 base 路径传进来
   （Worker 里没有 document，importScripts 需要绝对路径）。 */
self.__CP_BASE = '/';
try {
  const q = (self.location.search || '').replace(/^\?/, '');
  for (const kv of q.split('&')) {
    const [k, v] = kv.split('=');
    if (k === 'base' && v) self.__CP_BASE = decodeURIComponent(v);
  }
} catch (_) {}

importScripts(self.__CP_BASE + 'js/cv.js');
importScripts(self.__CP_BASE + 'js/clear.js');
importScripts(self.__CP_BASE + 'vendor/ort/ort.wasm.min.js');

const MS = 512;
let session = null;
let ortReady = false;
let ortError = null;          // 模型不可用时的「一次性」原因（含排查提示）
let initPromise = null;       // ★ in-flight 互斥：并发调用共享同一次加载

/* ── 运行环境判定 ────────────────────────────────────────────────────
   本地开发（serve.py / file://）走同源 models/，不产生任何外部请求；
   线上部署（GitHub Pages）放不下模型，必须靠外部源。 */
const IS_LOCAL = self.location.protocol === 'file:'
  || /^(127\.0\.0\.1|localhost|\[::1\])$/.test(self.location.hostname || '');

/* ★ 在线模型镜像，按顺序尝试。
 *
 * 为什么线上不把模型放 GitHub Release：
 *   实测 GitHub release 资产的响应**不带 Access-Control-Allow-Origin**，
 *   跨源 fetch 在浏览器里必被拦。注意：用 curl 看这个 URL 会**误判成"有 CORS"**，
 *   必须用真实浏览器判 —— 因为 302 跨主机重定向会让 curl 丢掉 Origin。
 *   hf-mirror 会回显 Origin（CORS 通过），国内直连可达，故选它做线上主源。 */
const MODEL_MIRRORS = [
  'https://hf-mirror.com/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
];

/* 全部源都失败时，给用户的离线兜底入口 */
const MODEL_DOWNLOAD_PAGE = 'https://github.com/baiqz/clearprint/releases';

/* ★ 线上主路径：把 199MB 模型切成 3 块随站点一起发布（GitHub 单文件硬上限 100MB），
   浏览器按序拉取后拼接。**同源**才是关键 ——
   实测第三方镜像（hf-mirror）在真实浏览器里连首页都过不了 CORS
   （corsError = MissingAllowOriginHeader），而 curl 访问同一地址完全正常。
   同源没有 CORS 可言，是浏览器里唯一稳的托管方式。 */
const MODEL_PARTS = ['lama_fp32.onnx.p1', 'lama_fp32.onnx.p2', 'lama_fp32.onnx.p3'];
const MODEL_BYTES = 208044816;      // 与 models/lama_fp32.onnx 一致（切块脚本已校验拼接哈希）

// ORT 配置：wasm-only。多线程需要 SharedArrayBuffer（= 需要跨源隔离）。
// 线上 GitHub Pages 不能自定义响应头，靠 coi-serviceworker 注入 COOP/COEP；
// 拿不到隔离时自动退回单线程 —— 照样能跑，只是慢一些。
ort.env.wasm.numThreads = (typeof SharedArrayBuffer !== 'undefined') ? 2 : 1;
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = self.__CP_BASE + 'vendor/ort/';

/** 按顺序给出模型源。
 *  本地环境（开发 / 自用）模型就在项目里，**只认同源单文件** ——
 *  失败要立刻说清，不去等一个注定超时的外部请求：那会把「快速中止」
 *  拖成慢动作，连带让批处理的保护行为（其余图退回待处理）来不及生效。
 *  线上则以站点分块为主（同源可靠），单文件与镜像只作兜底。 */
function modelSources() {
  const local = {
    kind: 'file',
    url: self.__CP_BASE + 'models/lama_fp32.onnx',
    tag: '本机 models/',
  };
  if (IS_LOCAL) return [local];
  const parts = {
    kind: 'parts',
    parts: MODEL_PARTS,
    bytes: MODEL_BYTES,
    tag: '站点分块',
    url: self.__CP_BASE + 'models/' + MODEL_PARTS[0],
  };
  const mirrors = MODEL_MIRRORS.map((u) => ({ kind: 'file', url: u, tag: '在线镜像' }));
  return [parts, local].concat(mirrors);
}

/** 把异常压成一行短句，便于在「已尝试」列表里展示。
 *  注意要按 **源的地址** 判性质，不能只看 hostname ——
 *  在本地跑时也可能去请求外部镜像，那种失败是「网络不可达」而非「文件缺失」。 */
function shortErr(e, url) {
  const raw = (e && (e.message || String(e))) || 'unknown';
  if (/HTTP (\d+)/.test(raw)) return raw.match(/HTTP \d+/)[0];
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
    let remote = false;
    if (/^https?:\/\//i.test(url || '')) {
      try { remote = new URL(url).origin !== self.location.origin; } catch (_) { remote = true; }
    }
    return remote ? '网络不可达' : '文件缺失';
  }
  if ((e && e.name === 'AbortError') || /abort/i.test(raw)) return '连接超时';
  return raw.slice(0, 40);
}

// ---- 下载层 ---------------------------------------------------------------
//
// ★ 为什么必须「分段 + 重试」：线上模型是同源 208MB 分块，一次到底地拉，
//   任何一个瞬时抖动都会让**已经拉到的几十 MB 全部作废**、直接换源。
//   实测真机第一次跑就在 46MB 处 network error，前 46MB 白下。
//   切成 8MB 段之后，一次抖动的代价只有当前这一段。
//
// ★ 重试只覆盖「网络类」失败。4xx 是确定性失败，重试只是白等 ——
//   直接抛给上层去换源（这是「系统级故障要尽快中止」的一部分）。
//
// ★ 跨源不能带 Range：Range 不是 CORS 安全列表头，会给镜像源触发一个
//   它多半答不上来的 OPTIONS 预检，把本来能用的兜底也弄坏。
//   所以只在同源时分段，跨源仍走整份下载。
const RANGE_SEG = 8 * 1048576;
const SEG_TRIES = 3;
const CONNECT_MS = 15000;      // 等响应头
const STALL_MS = 20000;        // 拿到头之后，连续多久没字节算卡死

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isSameOrigin(url) {
  try { return new URL(url, self.location.href).origin === self.location.origin; }
  catch (_) { return false; }
}

/** 4xx 里这几个是「确定不行」，重试只会白等。 */
function fatalStatus(code) {
  return code === 400 || code === 401 || code === 403 || code === 404
      || code === 410 || code === 416 || code === 429;
}

/** 交互式停滞守卫：同一套 AbortController 先守「等响应头」再守「读 body」。
 *  长时间没动静就主动 abort —— 让上层把这一段重试掉，
 *  而不是挂着永远不返回（用户看到的「卡住不动」就是这种）。 */
function stallGuard(ctl) {
  let t = null;
  return {
    arm: (ms) => { if (t) clearTimeout(t); t = setTimeout(() => ctl.abort(), ms); },
    stop: () => { if (t) { clearTimeout(t); t = null; } },
  };
}

/** 读响应体，逐块回报。每次拿到数据都 arm 一次停滞计时。 */
async function readStream(resp, onBytes, guard) {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const buf = await resp.arrayBuffer();          // 老浏览器没有流式 body
    if (onBytes) onBytes(buf.byteLength);
    return buf;
  }
  const reader = resp.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (guard) guard.arm(STALL_MS);
    if (onBytes) onBytes(n);
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out.buffer;
}

/** 取 [start, end] 这一段。
 *  返回 { whole, buf, total }：whole=true 表示服务器忽略了 Range、整份返回
 *  （本地 serve.py 就是这种），这时 buf 就是整个文件，直接用它。 */
async function fetchSeg(url, start, end, onBytes, ranged) {
  const ctl = new AbortController();
  const guard = stallGuard(ctl);
  const headers = {};
  if (ranged) headers.Range = 'bytes=' + start + '-' + end;
  guard.arm(CONNECT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      signal: ctl.signal,
      headers: headers,
    });
  } finally {
    guard.stop();
  }

  if (resp.status === 200) {
    guard.arm(STALL_MS);
    try {
      const buf = await readStream(resp, onBytes, guard);
      return { whole: true, buf: buf, total: buf.byteLength };
    } finally {
      guard.stop();
    }
  }
  if (resp.status !== 206) {
    const err = new Error('HTTP ' + resp.status);
    err.httpStatus = resp.status;
    throw err;
  }
  const m = /\/(\d+)\s*$/.exec(resp.headers.get('content-range') || '');
  guard.arm(STALL_MS);
  try {
    const buf = await readStream(resp, onBytes, guard);
    return { whole: false, buf: buf, total: m ? Number(m[1]) : 0 };
  } finally {
    guard.stop();
  }
}

/** 下载一个（大）文件，按段重试。onBytes(n) 报的是**本文件**已收字节数。 */
async function pullRanged(url, onBytes, onRetry) {
  const ranged = isSameOrigin(url);
  const pieces = [];
  let got = 0;            // 已**完整拿到**的字节（段边界）
  let received = 0;       // 累计收到过的字节（含失败那次的半截）
  let total = 0;
  let tries = 0;

  for (;;) {
    const end = total ? Math.min(got + RANGE_SEG, total) - 1
                      : got + RANGE_SEG - 1;
    const base = got;
    let res = null;
    let last = null;
    try {
      res = await fetchSeg(url, got, end,
        (n) => {
          if (base + n > received) received = base + n;
          if (onBytes) onBytes(base + n);
        }, ranged);
    } catch (e) {
      last = e;
    }

    if (res) {
      tries = 0;
      if (res.whole) return res.buf;            // 服务器整份返回 → 已完成
      if (!total) total = res.total;
      pieces.push(new Uint8Array(res.buf));
      got += res.buf.byteLength;
      if (!total || got >= total) break;
      continue;
    }

    if (last && last.httpStatus && fatalStatus(last.httpStatus)) throw last;
    // ★ 只在「已经下到字节」之后才重试。
    //   一上来就碰不通（DNS 不通/被墙/连接超时）是系统级故障，重试只会把
    //   「快中止」拖成 3 倍时长 —— 而批处理的保护行为（其余图退回待处理）
    //   正依赖这个快速中止。已经下到字节再断才是真·抖动，那才值得重试这
    //   一段（线上实测就是首段 46MB 处断，received>0 正是要救的场景）。
    if (!received) throw last || new Error('下载失败');
    tries++;
    if (tries >= SEG_TRIES) throw last || new Error('下载中断');
    if (onRetry) {
      onRetry(tries, total ? Math.floor((got / total) * 100) : 0, got, total);
    }
    await sleep(300 * tries);
  }

  const out = new Uint8Array(got);
  let off = 0;
  for (const p of pieces) { out.set(p, off); off += p.length; }
  return out.buffer;
}

/** 单个文件（本地单文件 / 在线镜像）。onBytes 传本文件已收字节数。 */
async function fetchBuffer(url, onBytes, onRetry) {
  return await pullRanged(url, onBytes, onRetry);
}

/** 同源分块加载：按序拉取各块并拼接成完整模型。线上主路径。
 *  onPct 拿到的是**整份模型**的进度（三块合起来算）。 */
async function fetchParts(parts, totalBytes, onPct, onRetry) {
  const pieces = [];
  let got = 0;
  for (const name of parts) {
    const url = self.__CP_BASE + 'models/' + name;
    const base = got;
    const buf = await pullRanged(url,
      (n) => {
        if (onPct) {
          const g = base + n;
          onPct(Math.min(99, Math.floor((g / totalBytes) * 100)), g, totalBytes);
        }
      },
      (attempt, pct, n) => {
        if (onRetry) {
          const g = base + n;
          onRetry(attempt, Math.min(99, Math.floor((g / totalBytes) * 100)), g, totalBytes);
        }
      });
    pieces.push(new Uint8Array(buf));
    got += buf.byteLength;
    if (onPct) onPct(Math.min(99, Math.floor((got / totalBytes) * 100)), got, totalBytes);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of pieces) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/** 所有源都失败时，拼出「说人话」的原因 —— 本地与线上给的建议不一样。 */
function buildModelError(tried) {
  const head = 'AI 修复模型没能加载成功。';
  if (IS_LOCAL) {
    return head + '已尝试：' + tried.join('；')
      + '。请确认 models/lama_fp32.onnx 存在（约 199MB），且页面是通过 serve.py 打开的。';
  }
  return head + '在线源都没成功：' + tried.join('；')
    + '。这只影响「实心水印 → AI 重建」这一条通路，'
    + '半透明水印（还原）不依赖模型，可以直接用。'
    + '若确实需要 AI 修复，可在 ' + MODEL_DOWNLOAD_PAGE + ' 手动下载模型，'
    + '改用本地版运行（把模型放到项目 models/ 目录后执行 python serve.py）。';
}

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

/**
 * ★★ 加载模型。三点必须记住：
 *  1) 【必须互斥】老铁的真实故障就是「页面刚打开、198MB 模型还在下载，
 *     用户已经点了开始处理」—— 每张图都会走到这里。没有 in-flight 互斥时，
 *     并发 2 会触发两次 198MB 下载 + 两次 InferenceSession.create，
 *     内存直接翻倍，失败率极高。
 *  2) 【失败必须可读】把原始报错 + 排查方向一起带出去，
 *     而不是让上层只能抛「模型未就绪」这种什么都没说的文案。
 *  3) 【失败只报一次】ortError 记下来，后续请求直接复用，不再反复重试 198MB。
 */
function init() {
  if (ortReady) return Promise.resolve(true);
  if (ortError) return Promise.resolve(false);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const tried = [];
    const sources = modelSources();
    try {
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        let buf = null;
        const meta = { source: src.tag };

        try {
          post(Object.assign({ type: 'progress', id: 'init', stage: 'model', pct: 0 }, meta));
          const onPct = (pct, got, bytes) => {
            post(Object.assign({ type: 'progress', id: 'init', stage: 'model',
                                 pct: pct, got: got, bytes: bytes }, meta));
          };
          // ★ 段内重试要**说出来**：否则用户只看到进度条倒退/不动，
          //   以为卡死了。这里把「第几次重试 / 共几次」带上去。
          const onRetry = (attempt, pct, got, bytes) => {
            post(Object.assign({ type: 'progress', id: 'init', stage: 'model',
                                 pct: pct || 0, got: got || 0, bytes: bytes || 0,
                                 retry: attempt, tries: SEG_TRIES }, meta));
          };
          buf = (src.kind === 'parts')
            ? await fetchParts(src.parts, src.bytes, onPct, onRetry)
            : await fetchBuffer(src.url, onPct, onRetry);
        } catch (e) {
          // ★ 下载失败只记一笔，换下一个源 —— 绝不在这里定生死
          tried.push(src.tag + '（' + shortErr(e, src.url) + '）');
          continue;
        }

        if (buf.byteLength < 1024 * 1024) {
          tried.push(src.tag + '（只拿到 ' + buf.byteLength + ' 字节）');
          continue;
        }

        // 下载成功 → 建推理会话。这一步失败就没有别的源可试了。
        try {
          post(Object.assign({ type: 'progress', id: 'init', stage: 'model', pct: 100 }, meta));
          session = await ort.InferenceSession.create(buf, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
          });
        } catch (e) {
          const raw = (e && (e.message || String(e))) || 'unknown';
          let hint = '';
          if (/no available backend|Failed to fetch/i.test(raw)) {
            hint = '。WebAssembly 后端没起来：请确认 vendor/ort/ 下的 wasm 文件可访问，'
                 + '且页面是 https 或本地 serve.py 打开的。';
          } else if (/protobuf|graph|Invalid/i.test(raw)) {
            hint = '。拿到的不是有效模型文件，下载源可能返回了错误页。';
          }
          ortError = 'AI 修复模型加载失败：' + raw + hint;
          session = null;
          post({ type: 'error', id: 'init', message: ortError });
          return false;
        }

        ortReady = true;
        post({ type: 'ready', source: src.tag });
        return true;
      }

      // 所有源都失败
      ortError = buildModelError(tried);
      session = null;
      post({ type: 'error', id: 'init', message: ortError });
      return false;
    } finally {
      // 成功后保留 Promise（幂等）；失败后清掉，允许用户「重试」
      if (!ortReady) initPromise = null;
    }
  })();

  return initPromise;
}

/** 供「重试失败项」用：把失败状态清掉，允许重新加载一次 */
function resetModel() {
  session = null;
  ortReady = false;
  ortError = null;
  initPromise = null;
}

/** 编码成 Blob。OffscreenCanvas.convertToBlob 缺失时退到普通 canvas.toBlob。 */
async function toBlob(canvas, mime, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    try {
      return await canvas.convertToBlob({ type: mime, quality });
    } catch (e) {
      // 某些实现不支持 quality 参数，退一次不带参数的
      try { return await canvas.convertToBlob({ type: mime }); } catch (_) {}
    }
  }
  // 回退：把 OffscreenCanvas 贴到普通 canvas 再 toBlob
  const c = new OffscreenCanvas(canvas.width, canvas.height);
  const cx = c.getContext('2d');
  cx.drawImage(canvas, 0, 0);
  // 没有 document 的 worker 里造不了 <canvas>，用 ImageBitmap + createImageBitmap 也不行；
  // 直接给出可读错误，别让 UI 只看到「不是函数」。
  const bmp = canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : null;
  if (!bmp) throw new Error('当前浏览器不支持图片编码（OffscreenCanvas.convertToBlob 缺失），请换用最新版 Chrome / Edge。');
  const oc = new OffscreenCanvas(canvas.width, canvas.height);
  oc.getContext('2d').drawImage(bmp, 0, 0);
  if (typeof oc.convertToBlob === 'function') return oc.convertToBlob({ type: mime, quality });
  throw new Error('当前浏览器不支持图片编码，请换用最新版 Chrome / Edge。');
}

/**
 * 单张图的 LaMa 修复（ROI 裁剪路线）。
 *
 * ★★ 「细节自动补充」的关键全在这个函数的**回贴策略**上。
 *
 * 旧版的病（本次修掉）：回贴用 `a > 0.004` 判据，而 `a` 来自 dilate 后的掩码——
 * 只要 ROI 里有掩码，它的羽化版在 ROI 内**处处非零**（feather 半径会把值铺满整个方形），
 * 于是**整个 ROI 方块**都被 AI 输出覆盖。而 AI 输出是 512×512 上采回来的，
 * 实测 ROI=753→512 时纹理只剩 **44%**、2048 的全宽水印只剩 **6%**。
 * 一句话：**为了修 1.2% 的水印区，把整张图 52%~100% 的面积都换成了糊图。**
 *
 * 正确的三段式回贴（保留「需要动多少就只动多少」）：
 *   ① 核心区（realMask 膨胀后，a=1）        → 全用 AI：水印被盖住的元素在这里被重建
 *   ② 融合带（core 外扩 band，a: 1→0）      → AI 与**原图高分辨率像素**做 alpha 混合，
 *      而且混的是"原图 + AI 的低频/原图的高频"，让 AI 的色调接得上、原图的细节保得住
 *   ③ 带外（a=0）                          → **一个像素都不动**，保持原分辨率锐度
 */
async function inpaintBitmap(img, mask, opts) {
  const o = opts || {};
  const T = MS;
  const dilateR = o.dilate == null ? 2 : o.dilate;
  const W = img.width, H = img.height;

  let work = mask;
  if (o.featherBefore) {
    // 先闭运算补断口，再膨胀 —— 半透明抗锯齿边缘是残留的主要来源
    work = CV.closeMask(work, 1);
  }
  // 真正要涂掉的水印区（物理真值），绝不外扩滥用
  const core = CV.dilate(work, dilateR);

  const box = CV.bbox(core, 8);
  if (!box) return { img, changed: false, roiPixels: 0 };

  // ---------------------------------------------------------------- ROI 规划
  // 融合带宽度：从 core 边界向外，AI 输出与原图渐变过渡，避免硬接缝。
  const band = Math.max(6, Math.round(o.band == null ? 12 : o.band));
  // 上下文：AI 需要「看到」周围内容才能编得对。但要受 512 输入预算约束——
  // ROI 越大，缩得越狠、细节丢得越多。所以取「够用即可」的值。
  const ctxX = Math.max(8, Math.round(Math.max(box.w, box.h) * (o.contextMargin == null ? 0.25 : o.contextMargin)));

  let x0 = Math.max(0, box.x - ctxX - band);
  let y0 = Math.max(0, box.y - ctxX - band);
  let x1 = Math.min(W, box.x + box.w + ctxX + band);
  let y1 = Math.min(H, box.y + box.h + ctxX + band);

  // 方形化（模型吃正方形；非方形会被拉伸变形）
  const side = Math.max(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const roi = {
    x: Math.round(cx - side / 2),
    y: Math.round(cy - side / 2),
    w: side, h: side,
  };

  // 裁图（边缘延拓）+ 缩放 512
  const cropT = CV.cropToTensor(img, roi, T);

  // 送进模型的掩码 = core（**不是**羽化后的软掩码）。
  // 送软掩码会让 AI 以为边界区"只是一半需要补"，结果糊得不够干净。
  // 边界过渡交给回贴阶段的 blend 做，模型只管把 core 填好。
  const maskT = CV.cropMaskToTensor(core, roi, T, 127);

  const inputImg = CLEAR.imageToTensor(cropT, T);
  const inputMask = CLEAR.maskToTensor(maskT, T);

  const feeds = {};
  const names = session.inputNames;
  feeds[names[0]] = new ort.Tensor('float32', inputImg, [1, 3, T, T]);
  feeds[names[1]] = new ort.Tensor('float32', inputMask, [1, 1, T, T]);

  const out = await session.run(feeds);
  const outName = session.outputNames[0];
  const outData = out[outName].data;

  // ★ 输出已是 0~255 量级，绝不再乘 255
  const resRGBA = CLEAR.tensorToRGBA(outData, T);

  // AI 结果回贴到 ROI 分辨率（这一步必然偏软，是 512 上采的代价，
  // 下面用「原图高频」把它补回来）。
  const aiRGBA = CV.bilinearRGBA(resRGBA, T, T, roi.w, roi.h);

  // ---------------------------------------------------------------- 三段式回贴
  // ① 逐像素把 core / 融合带裁到 ROI
  const roiCore = new Uint8Array(roi.w * roi.h);      // core 的硬掩码 0/1
  const roiBand = new Float32Array(roi.w * roi.h);    // 融合带权重 1→0
  for (let y = 0; y < roi.h; y++) {
    const sy = CV.clamp(roi.y + y, 0, H - 1);
    for (let x = 0; x < roi.w; x++) {
      const sx = CV.clamp(roi.x + x, 0, W - 1);
      const k = y * roi.w + x;
      roiCore[k] = core.data[sy * W + sx] > 127 ? 1 : 0;
    }
  }

  // ② 只在「core 外扩 band」的带子里算渐变权重（用距离变换的倒数近似，避免再做一次全图 blur）
  //    简化做法：对 core 做一次带内的加权外扩 —— 用 3×3 迭代传值，
  //    每轮把带内的最大权重减一个小步长，得到从 1 线性降到 0 的坡。
  const steps = Math.max(1, Math.round(band));
  const decl = 1 / (steps + 1);
  for (let k = 0; k < roiBand.length; k++) roiBand[k] = roiCore[k];
  let frontier = roiCore;
  for (let s = 1; s <= steps; s++) {
    const next = new Uint8Array(roi.w * roi.h);
    const val = (steps - s + 1) * decl;   // 第 s 圈 = (steps-s+1)/(steps+1)
    let grew = false;
    for (let y = 0; y < roi.h; y++) {
      for (let x = 0; x < roi.w; x++) {
        const k = y * roi.w + x;
        if (roiCore[k]) { next[k] = 1; continue; }
        if (frontier[k]) { next[k] = 1; continue; }
        // 4 邻域里若有上一圈的前沿 → 这一圈填上
        const up = y > 0 ? frontier[k - roi.w] : 0;
        const dn = y < roi.h - 1 ? frontier[k + roi.w] : 0;
        const lf = x > 0 ? frontier[k - 1] : 0;
        const rt = x < roi.w - 1 ? frontier[k + 1] : 0;
        if (up || dn || lf || rt) {
          next[k] = 1;
          roiBand[k] = val;
          grew = true;
        }
      }
    }
    frontier = next;
    if (!grew) break;
  }
  // core 本体权重恒为 1
  for (let k = 0; k < roiBand.length; k++) if (roiCore[k]) roiBand[k] = 1;

  // ③ 按三段权重合成。核心思路：
  //    - 只有 roiBand > 0 的像素才动（其余一个字节都不改 → 保留原图全部分辨率）
  //    - AI 提供低频（色调/结构），原图提供高频（纹理细节）
  const src = img.data;
  const aiLow = lowPassRGBA(aiRGBA, roi.w, roi.h, o.lowRadius == null ? 3 : o.lowRadius);
  let touched = 0, coreN = 0, bandN = 0;
  for (let y = 0; y < roi.h; y++) {
    const dy = roi.y + y;
    if (dy < 0 || dy >= H) continue;
    for (let x = 0; x < roi.w; x++) {
      const dx = roi.x + x;
      if (dx < 0 || dx >= W) continue;
      const k = y * roi.w + x;
      const a = roiBand[k];
      if (a <= 0.004) continue;
      const si = (dy * W + dx) * 4, bi = k * 4;
      if (roiCore[k]) {
        for (let c = 0; c < 3; c++) src[si + c] = aiRGBA[bi + c];
        coreN++;
      } else {
        // 融合带：AI 低频 + 原图高频（原图高频 = 原图 - 原图低频 ≈ 原图 - aiLow 的对应量）
        // 用 (原图 - aiLow) 作为高频残差，叠回 AI 低频上，再按 a 与原图混合。
        for (let c = 0; c < 3; c++) {
          const hi = src[si + c] - aiLow[bi + c];         // 原图相对 AI 低频的细节
          const detailed = aiRGBA[bi + c] + hi * (o.detailGain == null ? 0.85 : o.detailGain);
          const v = aiRGBA[bi + c] * a + detailed * (1 - a);
          src[si + c] = src[si + c] * (1 - a) + v * a;
        }
        bandN++;
      }
      touched++;
    }
  }
  return { img, changed: true, roi, touched, coreN, bandN, side, aiScale: T / side };
}

/** 可分离 box blur（RGBA 三通道，alpha 不动）。用于取 AI 输出的低频分量。 */
function lowPassRGBA(rgba, w, h, radius) {
  const r = Math.max(1, Math.round(radius || 3));
  const win = r * 2 + 1;
  const out = new Float32Array(w * h * 3);
  const tmp = new Float32Array(w * h * 3);
  const cl = CV.clamp;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += rgba[(row + cl(k, 0, w - 1)) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * 3 + c] = acc / win;
        acc += rgba[(row + cl(x + r + 1, 0, w - 1)) * 4 + c] - rgba[(row + cl(x - r, 0, w - 1)) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(cl(k, 0, h - 1) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = acc / win;
        acc += tmp[(cl(y + r + 1, 0, h - 1) * w + x) * 3 + c] - tmp[(cl(y - r, 0, h - 1) * w + x) * 3 + c];
      }
    }
  }
  // 直接写回 RGBA 结构（只用其三通道），alpha 保持 255 占位
  const res = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    res[i * 4] = out[i * 3];
    res[i * 4 + 1] = out[i * 3 + 1];
    res[i * 4 + 2] = out[i * 3 + 2];
    res[i * 4 + 3] = 255;
  }
  return res;
}

/** 透明水印：可见像素上的半透明叠加 → 逐通道 α 反解。
 *  返回 before 副本 + 自评，供「反解不合格时回滚改走 LaMa」。 */
function runAlphaRestore(img, mask, opts) {
  const before = new Uint8ClampedArray(img.data);
  const st = CLEAR.restoreAlpha(img, mask, opts);
  const beforeImg = { data: before, width: img.width, height: img.height };
  const sc = CLEAR.selfCheck(beforeImg, img, mask, {
    medianK: opts && opts.medianK, maxResidualRate: 0.25,
  });
  return { stats: st, check: sc, before };
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'init') { await init(); return; }
    if (msg.type === 'resetModel') { resetModel(); return; }

    if (msg.type === 'run') {
      const { id, bitmap, mask, opts } = msg;
      const o = opts || {};
      const bw = (bitmap && bitmap.width) || 0;
      const bh = (bitmap && bitmap.height) || 0;
      if (!bw || !bh) {
        // 位图已被 close / detach（或上游传了空位图）→ 给出可读原因
        throw new Error('图片位图不可用（可能在上一轮处理中被释放），请重新导入这张图片');
      }
      const canvas = new OffscreenCanvas(bw, bh);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close && bitmap.close();
      const idata = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const img = { data: idata.data, width: canvas.width, height: canvas.height };

      // 掩码按相对比例缩放到本图分辨率
      const m = {
        data: new Uint8ClampedArray(mask.data),
        width: mask.w, height: mask.h,
      };
      let scaled = m;
      if (m.width !== img.width || m.height !== img.height) {
        scaled = CV.scaleMask(m, img.width, img.height);
      }

      let mode = o.mode || 'auto';
      let alphaInfo = null;

      if (mode === 'auto' || mode === 'alpha') {
        post({ type: 'progress', id, stage: 'alpha', pct: 12 });
        const ares = runAlphaRestore(img, scaled, o.alpha || {});
        alphaInfo = ares;
        // ★ 自评不合格（掩码区仍有 >25% 像素明显残留）→ 回滚，转 LaMa
        const bad = !ares.check.ok && ares.stats.changed > 0;
        const noop = ares.stats.changed === 0;      // 一个像素都没动 → α 反解不适用
        // ★ 大面积饱和（α 反解被截到上限）→ 实心水印，α 反解只能拿中值背景兜底、
        //   纹理会被抹平。这种图数学上无解，正解是 LaMa 生成纹理。
        //   实测分离度：半透明夹具饱和率 0.0%，实心夹具 67.3% → 阈值 0.15 余量极宽。
        const solid = (ares.stats.satRate || 0) >= (o.solidSatRate == null ? 0.15 : o.solidSatRate);
        if (mode === 'alpha' || (!bad && !noop && !solid)) {
          mode = 'alpha';
        } else {
          img.data.set(ares.before);                // 回滚到处理前
          mode = 'lama';
          alphaInfo = null;                         // α 结果作废（不要把它当结论上报）
        }
      }

      if (mode === 'lama') {
        // ★ 不再「没就绪就抛错」：模型可能还在下载（198MB），这里等它。
        //   真的没成，再抛出【一次可读的】原因，而不是让每张图各报一遍。
        if (!ortReady) {
          post({ type: 'progress', id, stage: 'model', pct: 20 });
          await init();
        }
        if (!ortReady || !session) {
          throw new Error(ortError || 'AI 修复模型不可用');
        }
        post({ type: 'progress', id, stage: 'inpaint', pct: 40 });
        await inpaintBitmap(img, scaled, o.lama || {});
      }

      post({ type: 'progress', id, stage: 'encode', pct: 88 });
      const outCanvas = new OffscreenCanvas(img.width, img.height);
      const octx = outCanvas.getContext('2d');
      octx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      // ★ convertToBlob 在部分浏览器（旧 Firefox / Safari）缺失，
      //   缺了就直接抛「不是函数」→ 整批秒红。这里做一次能力回退。
      const mime = o.format === 'png' ? 'image/png' : 'image/jpeg';
      const q = o.quality == null ? 0.94 : o.quality;
      const blob = await toBlob(outCanvas, mime, q);
      post({ type: 'done', id, blob, mode, alpha: alphaInfo ? {
        changed: alphaInfo.stats.changed,
        skipped: alphaInfo.stats.skipped,
        alphaMean: alphaInfo.stats.alphaMean,
        alphaMax: alphaInfo.stats.alphaMax,
        satN: alphaInfo.stats.satN, satRate: alphaInfo.stats.satRate,
        W: alphaInfo.stats.W, gc: alphaInfo.stats.gc, k: alphaInfo.stats.medianK,
        residualRate: alphaInfo.check.residualRate,
        checkOk: alphaInfo.check.ok,
      } : null }, []);
      return;
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, message: (e && (e.message || String(e))) || 'unknown' });
  }
};

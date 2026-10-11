"""ClearPrint 本地服务器。

两个硬性原因不能 file:// 打开：
  1. file:// 的 origin 是 null，Worker 会被拒绝，fetch 模型也读不到；
  2. ORT 多线程 WASM 需要 SharedArrayBuffer，而它要求 COOP+COEP 跨源隔离头。

用法：python serve.py [port]      默认 8788
      WM_NO_OPEN=1 时不自动开浏览器（给 e2e 用）
"""
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8788

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.onnx': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
}

# 内存里缓存大文件（模型 198MB，反复 Range 请求别每次都读盘）
_CACHE = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # ★ 跨源隔离：SharedArrayBuffer 的前提，ORT 多线程靠它
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        if ext in MIME:
            return MIME[ext]
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        if os.environ.get('WM_VERBOSE'):
            sys.stdout.write('  %s\n' % (fmt % args))

    def do_GET(self):
        # ★ 测试钩子：WM_BREAK_MODEL=1 时让模型 404。
        #   用来验证「模型不可用」时产品的失败姿态（不是 19 张全红 + 0.0s）。
        if os.environ.get('WM_BREAK_MODEL') and 'lama_fp32.onnx' in self.path:
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        # ★ 测试钩子：WM_SLOW_MODEL=<秒> 时把模型分块慢发。
        #   复刻老铁的真实时序：页面刚打开、198MB 还在下，用户已经点了「开始处理」。
        if os.environ.get('WM_SLOW_MODEL') and 'lama_fp32.onnx' in self.path:
            import time as _t
            delay = float(os.environ['WM_SLOW_MODEL'])
            path = self.translate_path(self.path)
            try:
                f = open(path, 'rb')
            except OSError:
                self.send_error(404, 'not found')
                return
            with f:
                size = os.fstat(f.fileno()).st_size
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.end_headers()
                chunk = max(1, size // 24)
                while True:
                    b = f.read(chunk)
                    if not b:
                        break
                    self.wfile.write(b)
                    _t.sleep(delay / 24.0)
            return
        # 预检/直读大文件：走通用路径
        return super().do_GET()

    def do_HEAD(self):
        return super().do_HEAD()

    def do_PUT(self):
        """★ 测试钩子：把 e2e 结果图落盘。

        python serve.py --put-dir <目录>  时才生效。
        存在的理由：浏览器测出来的 PNG 结果有 9MB，走 CDP 的 WebSocket 回传会撞
        「Message size 9183933 exceeds limit 4194304」（真的踩过）。
        改成页面 fetch PUT 到这里、Python 侧从磁盘读，就绕开了传输上限。

        默认（不带 --put-dir）返回 403，不留任何写入面。
        """
        put_dir = getattr(self.server, 'put_dir', None)
        if not put_dir or not self.path.startswith('/__result/'):
            self.send_error(403, 'put not enabled')
            return
        name = os.path.basename(self.path[len('/__result/'):]) or 'out.bin'
        # 只允许 ASCII 文件名，防路径穿越与中文名乱码
        name = ''.join(ch for ch in name if ch.isascii() and (ch.isalnum() or ch in '._-'))
        if not name:
            self.send_error(400, 'bad name')
            return
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        os.makedirs(put_dir, exist_ok=True)
        dst = os.path.join(put_dir, name)
        with open(dst, 'wb') as f:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    args = [a for a in sys.argv[1:]]
    put_dir = None
    if '--put-dir' in args:
        i = args.index('--put-dir')
        put_dir = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    port = int(args[0]) if args else DEFAULT_PORT
    srv = ThreadingServer(('127.0.0.1', port), Handler)
    srv.put_dir = put_dir
    url = 'http://127.0.0.1:%d/index.html' % port
    print('ClearPrint 服务已启动：%s' % url, flush=True)
    print('  根目录：%s' % ROOT, flush=True)
    if put_dir:
        print('  结果落盘目录（测试）：%s' % put_dir, flush=True)
    print('  按 Ctrl+C 停止', flush=True)
    if not os.environ.get('WM_NO_OPEN'):
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止', flush=True)
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()

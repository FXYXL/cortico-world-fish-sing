# -*- coding: utf-8 -*-
"""
fish-sing 常驻服务：把 engine.py 包成 HTTP，供 TS 扩展调用。

为什么是常驻：RVC 每次起进程要重载 hubert + rmvpe + G + faiss（约 8 秒），
常驻后 55 秒音频只要 4 秒。代价是这个进程会一直占着约 1.5 GB 显存。

为什么用标准库 http.server 而不是 FastAPI/Flask：这个 worker 跑在 RVC 的 venv 里，
那个环境是为推理配的（torch/numpy/soundfile），没装 web 框架。少一个依赖少一个崩点。

接口（全部 JSON，只监听 127.0.0.1）：
  GET  /health                → 引擎状态、队列、当前任务
  POST /job    {...}          → 入队，返回 {id}
  GET  /job/<id>              → 任务状态 {state, progress, message, result}
  POST /stop                  → 取消当前任务
  GET  /doctor                → 环境自检

任务串行执行：一个队列一个线程。GPU 只有一张卡，并发只会互相拖死
（实测两个 torch 进程同时抢卡会把训练整段冻住 10 分钟以上）。
"""

import json
import os
import queue
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from engine import CHUNK_SEC, SingEngine, doctor, log

PORT = int(os.environ.get("FISHSING_PORT", "9890"))
TOKEN = os.environ.get("FISHSING_TOKEN", "").strip()
WORK_ROOT = Path(os.environ.get("FISHSING_WORK", r"D:\AI\cortico-world-fish-sing\data\work"))

ENGINE = SingEngine()
JOBS: dict = {}
JOB_ORDER: list = []
CURRENT = {"id": None, "cancel": None}
QUEUE: "queue.Queue[tuple]" = queue.Queue()
LOCK = threading.Lock()


def now() -> float:
    return time.time()


def new_job(kind: str, params: dict) -> dict:
    jid = uuid.uuid4().hex[:12]
    job = {
        "id": jid,
        "kind": kind,
        "params": params,
        "state": "queued",
        "progress": 0.0,
        "message": "排队中",
        "createdAt": now(),
        "result": None,
        "error": "",
    }
    with LOCK:
        JOBS[jid] = job
        JOB_ORDER.append(jid)
        # 只留最近 50 条，避免长时间运行把内存撑大
        while len(JOB_ORDER) > 50:
            JOBS.pop(JOB_ORDER.pop(0), None)
    QUEUE.put((jid, kind, params))
    return job


def update(jid: str, **kw) -> None:
    with LOCK:
        job = JOBS.get(jid)
        if job:
            job.update(kw)


def worker_loop() -> None:
    while True:
        jid, kind, params = QUEUE.get()
        cancel = threading.Event()
        with LOCK:
            CURRENT["id"] = jid
            CURRENT["cancel"] = cancel
        update(jid, state="running", message="开始", startedAt=now())
        try:
            result = run_job(jid, kind, params, cancel)
            update(jid, state="done", progress=1.0, message="完成", result=result, endedAt=now())
            log(f"任务 {jid} 完成：{result.get('output', '')}")
        except Exception as e:  # noqa: BLE001
            if cancel.is_set():
                update(jid, state="canceled", message="已取消", endedAt=now())
            else:
                update(jid, state="error", message=str(e)[:500],
                       error=traceback.format_exc()[-1500:], endedAt=now())
                log(f"任务 {jid} 失败：{e}")
        finally:
            with LOCK:
                CURRENT["id"] = None
                CURRENT["cancel"] = None
            QUEUE.task_done()


def run_job(jid: str, kind: str, params: dict, cancel: threading.Event) -> dict:
    # 做数据集不需要唱歌模型：白加载会占用 1.5 GB 显存，还会让 demucs 更容易 OOM
    if kind in ("song", "convert") and not ENGINE.ready:
        update(jid, message="加载模型")
        ENGINE.load()

    def progress(p: float, m: str) -> None:
        update(jid, progress=round(max(0.0, min(1.0, p)), 3), message=m)

    if kind == "song":
        src = Path(params["input"])
        if not src.is_file():
            raise RuntimeError(f"输入文件不存在：{src}")
        work = Path(params.get("work") or (WORK_ROOT / jid))
        return ENGINE.song(
            src, work,
            separate=bool(params.get("separate", True)),
            mode=str(params.get("mode", "full")),
            pitch=int(params.get("pitch", 0)),
            index_rate=float(params.get("index_rate", 0.75)),
            protect=float(params.get("protect", 0.33)),
            progress=progress,
            cancel=cancel,
        )

    if kind == "convert":
        src = Path(params["input"])
        dst = Path(params["output"])
        work = Path(params.get("work") or (WORK_ROOT / jid))
        work.mkdir(parents=True, exist_ok=True)
        return ENGINE.convert(
            src, dst,
            pitch=int(params.get("pitch", 0)),
            index_rate=float(params.get("index_rate", 0.75)),
            protect=float(params.get("protect", 0.33)),
            progress=progress, cancel=cancel,
        )

    if kind == "dataset":
        import dataset as ds
        out = Path(params.get("out") or (WORK_ROOT / "datasets" / jid))
        return ds.build(
            sources=params.get("sources") or [],
            out_dir=out,
            params=params,
            progress=progress,
            cancel=cancel,
        )

    raise RuntimeError(f"未知任务类型：{kind}")


def status() -> dict:
    with LOCK:
        cur = CURRENT["id"]
        job = JOBS.get(cur) if cur else None
        return {
            "ok": True,
            "engine": ENGINE.info(),
            "queue": QUEUE.qsize(),
            "current": {"id": cur, "message": job["message"], "progress": job["progress"]} if job else None,
            "chunkSec": CHUNK_SEC,
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 别让默认 access log 刷屏
        return

    # -- 工具 --------------------------------------------------

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self) -> bool:
        if not TOKEN:
            return True
        h = self.headers.get("Authorization", "")
        return h.strip() == f"Bearer {TOKEN}"

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"请求体不是合法 JSON：{e}")

    # -- 路由 --------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        try:
            if self.path.startswith("/health"):
                self._json(200, status())
                return
            if self.path.startswith("/doctor"):
                self._json(200, doctor())
                return
            if self.path.startswith("/job/"):
                jid = self.path.split("/job/", 1)[1].split("?")[0]
                with LOCK:
                    job = JOBS.get(jid)
                if not job:
                    self._json(404, {"ok": False, "message": "没有这个任务"})
                    return
                self._json(200, {"ok": True, "job": job})
                return
            self._json(404, {"ok": False, "message": "未知路径"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"ok": False, "message": str(e)})

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self._auth_ok():
                self._json(401, {"ok": False, "message": "令牌不对"})
                return
            if self.path.startswith("/scan"):
                import dataset as ds
                body = self._body()
                paths = body.get("paths") or []
                if not paths:
                    self._json(400, {"ok": False, "message": "没给路径"})
                    return
                self._json(200, {"ok": True, "items": ds.scan(paths)})
                return
            if self.path.startswith("/stop"):
                with LOCK:
                    cancel = CURRENT["cancel"]
                if cancel:
                    cancel.set()
                    self._json(200, {"ok": True, "message": "已请求取消"})
                else:
                    self._json(200, {"ok": True, "message": "当前没有任务"})
                return
            if self.path.startswith("/job"):
                body = self._body()
                kind = str(body.pop("kind", "song"))
                if kind not in ("song", "convert", "dataset"):
                    self._json(400, {"ok": False, "message": f"未知任务类型：{kind}"})
                    return
                job = new_job(kind, body)
                self._json(200, {"ok": True, "id": job["id"]})
                return
            self._json(404, {"ok": False, "message": "未知路径"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"ok": False, "message": str(e), "trace": traceback.format_exc()[-800:]})


def main() -> None:
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    t = threading.Thread(target=worker_loop, name="fishsing-job", daemon=True)
    t.start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"fish-sing worker 监听 127.0.0.1:{PORT}（工作目录 {WORK_ROOT}）")
    # 预热：先把模型读进来，第一个请求就不用等 8 秒。
    # FISHSING_NO_WARMUP=1 可关掉——做准备数据集这类不需要唱歌模型的任务时，
    # 白占 1.5 GB 显存会让 demucs 更容易 OOM。
    if os.environ.get("FISHSING_NO_WARMUP") != "1":
        threading.Thread(target=lambda: ENGINE.load(), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("收到 Ctrl-C，退出")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()

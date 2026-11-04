#!/usr/bin/env python3
"""Fault-phase Hermes provider checks against a real Runtime sidecar.

The Node host-E2E runner starts the real Memory Runtime sidecar and real
capability/graph path.  This script starts a tiny local response shim in front
of that real sidecar so the *real* provider adapter can be driven through
200-failed, 202-queued, detail-partial, offline/recovery, 401, 429, mode-off,
dead-letter and checkpoint-unconfirmed responses.  The shim only changes the
HTTP response; every pass-through request still reaches the real sidecar.

This is real provider + real sidecar/graph, with a controlled response shim.
It is not a real Hermes gateway process and does not call an LLM.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import error as urlerror
from urllib import request as urlrequest

MARKER = "HERMES_FAULT_RESULT "
sys.dont_write_bytecode = True


def install_hermes_stub() -> None:
    try:
        importlib.import_module("agent.memory_provider")
        return
    except Exception:
        pass

    agent = types.ModuleType("agent")
    agent.__path__ = []  # type: ignore[attr-defined]
    memory_provider = types.ModuleType("agent.memory_provider")

    class MemoryProvider:
        pre_compress_checkpoint_api_version = 1

        @property
        def name(self) -> str:
            raise NotImplementedError

        def is_available(self) -> bool:
            raise NotImplementedError

        def initialize(self, session_id: str, **kwargs: Any) -> None:
            raise NotImplementedError

        def get_tool_schemas(self) -> List[Dict[str, Any]]:
            raise NotImplementedError

    def spawn_context_thread(
        target: Any,
        *,
        name: str,
        daemon: bool = True,
        args: tuple = (),
        kwargs: Optional[Dict[str, Any]] = None,
    ) -> threading.Thread:
        return threading.Thread(target=target, name=name, args=args,
                                kwargs=kwargs or {}, daemon=daemon)

    memory_provider.MemoryProvider = MemoryProvider  # type: ignore[attr-defined]
    memory_provider.spawn_context_thread = spawn_context_thread  # type: ignore[attr-defined]
    sys.modules["agent"] = agent
    sys.modules["agent.memory_provider"] = memory_provider


def load_plugin() -> Any:
    plugin_path = Path(__file__).resolve().parents[3] / "integrations" / "hermes" / "mebular-memory" / "__init__.py"
    spec = importlib.util.spec_from_file_location("mebular_memory_fault_plugin", plugin_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {plugin_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["mebular_memory_fault_plugin"] = module
    spec.loader.exec_module(module)
    return module


class FaultProxy:
    def __init__(self, sidecar_api: str, token: str) -> None:
        from urllib import parse as urlparse
        parsed = urlparse.urlsplit(sidecar_api.rstrip("/"))
        self.sidecar_origin = f"{parsed.scheme}://{parsed.netloc}"
        self.sidecar_api = sidecar_api.rstrip("/")
        self.token = token
        self.mode = "normal"
        self.lock = threading.Lock()
        self.requests: List[Dict[str, Any]] = []
        self.offline_seen: set[str] = set()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _ProxyHandler)
        self.httpd.daemon_threads = True
        self.httpd.proxy = self  # type: ignore[attr-defined]
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        )
        self.thread.start()

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def record(self, method: str, path: str, body: Dict[str, Any]) -> None:
        with self.lock:
            self.requests.append({"method": method, "path": path, "body": body})

    def request_count(self) -> int:
        with self.lock:
            return len(self.requests)

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=1.0)


class _ProxyHandler(BaseHTTPRequestHandler):
    server: "ThreadingHTTPServer"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    @property
    def proxy(self) -> FaultProxy:
        return self.server.proxy  # type: ignore[attr-defined]

    def _body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            value = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            value = {}
        return value if isinstance(value, dict) else {}

    def _send(self, status: int, payload: Dict[str, Any],
              headers: Optional[Dict[str, str]] = None) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _envelope(self, data: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ok": True,
            "requestId": "req_fault",
            "apiVersion": 1,
            "data": data,
            "warnings": [],
            "degraded": False,
        }

    def _error(self, status: int, code: str, retryable: bool = False,
               retry_after: Optional[str] = None) -> None:
        headers = {"Retry-After": retry_after} if retry_after is not None else {}
        self._send(status, {
            "ok": False,
            "requestId": "req_fault",
            "apiVersion": 1,
            "error": {"code": code, "message": "fault shim", "retryable": retryable},
        }, headers)

    def _forward(self, method: str, path: str, body: bytes) -> None:
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.proxy.token}",
        }
        for name in ("Content-Type", "Idempotency-Key"):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        request = urlrequest.Request(
            f"{self.proxy.sidecar_origin}{path}", data=body or None,
            headers=headers, method=method,
        )
        try:
            with urlrequest.urlopen(request, timeout=10) as response:
                status = response.status
                raw = response.read()
                content_type = response.headers.get("Content-Type", "application/json")
        except urlerror.HTTPError as error:
            status = error.code
            raw = error.read()
            content_type = error.headers.get("Content-Type", "application/json")
        except Exception as error:
            self._error(502, "fault_proxy_forward_failed", retryable=True)
            return
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle(self, method: str) -> None:
        from urllib import parse as urlparse
        parsed = urlparse.urlsplit(self.path)
        path = parsed.path
        if parsed.query:
            path = f"{path}?{parsed.query}"
        body_bytes = b""
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            body_bytes = self.rfile.read(length)
        body = {}
        try:
            value = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            body = value if isinstance(value, dict) else {}
        except Exception:
            body = {}
        self.proxy.record(method, parsed.path, body)
        mode = self.proxy.mode

        if path.startswith("/memory-runtime/v1/status"):
            if mode == "mode_mismatch":
                self._error(409, "mode_mismatch")
            else:
                self._forward(method, path, body_bytes)
            return
        if mode == "mode_mismatch":
            self._error(409, "mode_mismatch")
            return
        if mode == "always401":
            self._error(401, "unauthorized")
            return
        if mode == "always429":
            self._error(429, "rate_limited", retryable=True, retry_after="0")
            return
        if method == "POST" and path == "/memory-runtime/v1/ingest":
            if mode == "offline_once":
                request_id = str(body.get("requestId") or "")
                with self.proxy.lock:
                    first = request_id not in self.proxy.offline_seen
                    self.proxy.offline_seen.add(request_id)
                if first:
                    self.close_connection = True
                    try:
                        self.connection.close()
                    except Exception:
                        pass
                    return
            if mode == "failed200":
                self._send(200, self._envelope({
                    "accepted": {"chunks": 1, "records": 0},
                    "records": [],
                    "extraction": {"status": "failed"},
                    "queued": False,
                    "degraded": True,
                    "warnings": ["candidate_write_failed:fault_injected"],
                    "duplicate": False,
                }))
                return
            if mode == "queued202":
                self._send(202, self._envelope({
                    "records": [],
                    "extraction": {"status": "pending"},
                    "queued": True,
                    "degraded": True,
                    "warnings": ["queued_outbox"],
                    "duplicate": False,
                }))
                return
            if mode == "detailpartial":
                self._send(200, self._envelope({
                    "records": [],
                    "extraction": {"status": "completed"},
                    "queued": False,
                    "degraded": True,
                    "detail": {"ids": [], "written": 0, "duplicates": 0,
                               "queued": 0, "failed": 1},
                    "warnings": ["detail_write_failed:fault_injected"],
                    "duplicate": False,
                }))
                return
        if method == "PUT" and path.startswith("/memory-runtime/v1/checkpoints/"):
            if mode == "checkpoint202":
                self._send(202, self._envelope({
                    "checkpoint": {"revision": None, "pending": True},
                    "pending": True,
                    "source": "cache",
                    "degraded": True,
                }))
                return
            if mode == "checkpoint_unconfirmed":
                self._send(200, self._envelope({
                    "checkpoint": {"summary": body.get("summary"),
                                   "state": body.get("state")},
                    "source": "cloud",
                }))
                return
        self._forward(method, path, body_bytes)

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")


def wait_until(predicate: Any, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def main() -> int:
    install_hermes_stub()
    plugin = load_plugin()
    config = json.loads(os.environ["HERMES_E2E_CONFIG"])
    hermes_home = Path(os.environ["HERMES_HOME"])
    token_file = Path(config["sidecar_token_file"])
    token_record = json.loads(token_file.read_text(encoding="utf-8"))
    token = str(token_record.get("token") or "") if isinstance(token_record, dict) else token_file.read_text().strip()
    proxy = FaultProxy(config["sidecar_url"], token)
    suffix = str(config["suffix"])
    sentinel = str(config["sentinel"])

    (hermes_home / "mebular-memory.json").write_text(json.dumps({
        "runtime_url": proxy.url,
        "agent_id": "hermes",
        "extractor": "heuristic",
        "recall_timeout": 1.0,
        "ingest_timeout": 1.0,
        "checkpoint_timeout": 1.0,
        "archive_flush_timeout": 1.0,
        "sync_max_attempts": 2,
        "queue_limit": 100,
    }, indent=2), encoding="utf-8")

    provider = plugin.MebularMemoryProvider()
    provider.initialize("hermes-fault", hermes_home=str(hermes_home),
                        platform="cli", agent_context="primary")
    result: Dict[str, Any] = {"suffix": suffix}
    try:
        # Normal pass-through: real sidecar/graph commit.
        proxy.mode = "normal"
        provider.sync_turn(f"normal {suffix}", "ok", session_id="hermes-fault")
        result["normalFlushed"] = bool(provider.flush(timeout=8.0))

        proxy.mode = "failed200"
        provider.sync_turn(f"failed {suffix}", "no", session_id="hermes-fault")
        result["failedFlushed"] = bool(provider.flush(timeout=8.0))

        proxy.mode = "queued202"
        provider.sync_turn(f"queued {suffix}", "no", session_id="hermes-fault")
        result["queuedFlushed"] = bool(provider.flush(timeout=8.0))

        proxy.mode = "detailpartial"
        provider.sync_turn(f"partial {suffix}", "no", session_id="hermes-fault")
        result["partialFlushed"] = bool(provider.flush(timeout=8.0))

        proxy.mode = "offline_once"
        provider.sync_turn(f"offline {suffix}", "ok", session_id="hermes-fault")
        result["offlineFlushed"] = bool(provider.flush(timeout=8.0))

        proxy.mode = "always401"
        provider.sync_turn(f"auth {suffix}", "no", session_id="hermes-fault")
        result["authFlushed"] = bool(provider.flush(timeout=8.0))

        proxy.mode = "always429"
        provider.sync_turn(f"rate {suffix}", "no", session_id="hermes-fault")
        result["rateFlushed"] = bool(provider.flush(timeout=8.0))

        proxy.mode = "mode_mismatch"
        provider.sync_turn(f"mode {suffix}", "no", session_id="hermes-fault")
        result["modeBlocked"] = wait_until(
            lambda: "modeBlocked" in provider.get_status_config(), timeout=5.0
        )
        before = proxy.request_count()
        for _ in range(5):
            provider.sync_turn(f"mode-still-off {suffix}", "no", session_id="hermes-fault")
        result["modeRequestsStable"] = proxy.request_count() == before
        result["modePending"] = int(provider.pending())
        proxy.mode = "normal"
        provider._mode_probe_at = 0.0
        provider._discovery_checked_at = 0.0
        provider._ensure_runtime(force=True)
        result["modeRecovered"] = wait_until(
            lambda: "modeBlocked" not in provider.get_status_config(), timeout=5.0
        )
        result["modeRecoveryFlushed"] = bool(provider.flush(timeout=8.0))

        proxy.mode = "checkpoint202"
        provider.on_pre_compress([
            {"role": "user", "content": f"checkpoint-202 {suffix}"},
        ])
        result["checkpointHandoffFlushed"] = bool(provider.flush(timeout=8.0))
        result["checkpointHandoffPending"] = int(provider.checkpoint_pending())

        proxy.mode = "checkpoint_unconfirmed"
        provider.on_pre_compress([
            {"role": "user", "content": f"checkpoint-unconfirmed {suffix}"},
        ])
        result["checkpointUnconfirmedPending"] = int(provider.checkpoint_pending())

        proxy.mode = "normal"
        provider.on_pre_compress(
            [
                {"role": "user", "content": f"checkpoint-sentinel {suffix}"},
                {"role": "assistant", "content": "noted"},
            ],
            summary=(
                "Objective: keep the host safe\n"
                "Next Steps:\n"
                f"- never persist password={sentinel}\n"
                f"- token: {sentinel}\n"
            ),
        )
        result["checkpointSentinelFlushed"] = bool(provider.flush(timeout=8.0))

        result["status"] = provider.get_status_config()
        result["deadRecords"] = len([
            line for line in (hermes_home / "mebular-memory" / "dead.jsonl")
            .read_text(encoding="utf-8").splitlines() if line.strip()
        ]) if (hermes_home / "mebular-memory" / "dead.jsonl").exists() else 0
        result["queueText"] = (hermes_home / "mebular-memory" / "queue.jsonl").read_text(
            encoding="utf-8"
        ) if (hermes_home / "mebular-memory" / "queue.jsonl").exists() else ""
        result["deadText"] = (hermes_home / "mebular-memory" / "dead.jsonl").read_text(
            encoding="utf-8"
        ) if (hermes_home / "mebular-memory" / "dead.jsonl").exists() else ""
    finally:
        provider.shutdown()
        proxy.close()
        result["pendingAfterShutdown"] = int(provider.pending())
        result["checkpointPendingAfterShutdown"] = int(provider.checkpoint_pending())
    print(MARKER + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(MARKER + json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        raise

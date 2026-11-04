"""Executable tests for the Hermes Mebular sidecar integrations.

Run from the repository root:

    python3 -m unittest discover -s integrations/hermes/tests -v

The tests use only the Python standard library and a fake sidecar HTTP server;
they never touch a real Hermes profile, Mebular runtime, network, or
credentials.  Every request is asserted against the sidecar host API
``/memory-runtime/v1``; the retired ``/runtime/v1`` prototype must not be used.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from unittest import mock
from urllib import parse as urlparse

ROOT = Path(__file__).resolve().parents[1]
MEMORY_PLUGIN = ROOT / "mebular-memory" / "__init__.py"
COMPANION_PLUGIN = ROOT / "mebular-companion" / "__init__.py"

API = "/memory-runtime/v1"


def _install_hermes_stub() -> None:
    """Provide the tiny MemoryProvider surface when Hermes is not installed."""
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

    @dataclass(frozen=True)
    class RecallStatus:
        provider_label: str
        count: int
        glyph: str = "🧠"

    def spawn_context_thread(
        target: Callable[..., Any],
        *,
        name: str,
        daemon: bool = True,
        args: tuple = (),
        kwargs: Optional[Dict[str, Any]] = None,
    ) -> threading.Thread:
        return threading.Thread(
            target=target, name=name, args=args, kwargs=kwargs or {}, daemon=daemon
        )

    memory_provider.MemoryProvider = MemoryProvider  # type: ignore[attr-defined]
    memory_provider.RecallStatus = RecallStatus  # type: ignore[attr-defined]
    memory_provider.spawn_context_thread = spawn_context_thread  # type: ignore[attr-defined]
    sys.modules["agent"] = agent
    sys.modules["agent.memory_provider"] = memory_provider


def _load_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_install_hermes_stub()
memory_plugin = _load_module(MEMORY_PLUGIN, "mebular_memory_plugin_under_test")
companion_plugin = _load_module(COMPANION_PLUGIN, "mebular_companion_plugin_under_test")


class _Handler(BaseHTTPRequestHandler):
    server: "_FakeServer"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

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
            # The timeout test intentionally drops the connection.
            pass

    def _envelope(self, data: Dict[str, Any], request_id: str = "req_test") -> Dict[str, Any]:
        return {
            "ok": True,
            "requestId": request_id,
            "apiVersion": 1,
            "data": data,
            "warnings": [],
            "degraded": False,
        }

    def _error(self, status: int, code: str, message: str = "fake sidecar error") -> None:
        fake = self.server.fake
        headers = {}
        if fake.retry_after:
            headers["Retry-After"] = str(fake.retry_after)
        self._send(
            status,
            {
                "ok": False,
                "requestId": "req_test",
                "apiVersion": 1,
                "error": {"code": code, "message": message, "retryable": status >= 500},
            },
            headers=headers,
        )

    def _body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            value = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            value = {}
        return value if isinstance(value, dict) else {}

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse.urlsplit(self.path)
        fake = self.server.fake
        fake.record("GET", parsed.path, {}, self.headers)
        if parsed.path == f"{API}/health":
            self._send(200, {
                "ok": True,
                "apiVersion": 1,
                "state": "ready",
                "ready": True,
                "pid": os.getpid(),
                "runtimeVersion": "0.3.0",
            })
            return
        if parsed.path.startswith(f"{API}/checkpoints/"):
            if fake.mode == "error":
                self._error(fake.error_status, fake.error_code)
                return
            self._send(200, self._envelope({
                "checkpoint": {
                    "revision": fake.checkpoint_revision,
                    "threadId": parsed.path.rsplit("/", 1)[-1],
                },
                "source": "cloud",
            }))
            return
        self._error(404, "not_found")

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse.urlsplit(self.path)
        body = self._body()
        fake = self.server.fake
        fake.record("PUT", parsed.path, body, self.headers, parsed.query)
        if parsed.path.startswith(f"{API}/checkpoints/"):
            fake.checkpoint_puts.append(body)
            if fake.mode == "error":
                self._error(fake.error_status, fake.error_code)
                return
            if fake.checkpoint_always_conflict or (
                fake.checkpoint_conflict and body.get("expectedRevision") is None
            ):
                if not fake.checkpoint_always_conflict:
                    fake.checkpoint_conflict = False
                self._error(409, "revision_mismatch", "revision mismatch")
                return
            if fake.checkpoint_pending:
                self._send(202, self._envelope({
                    "checkpoint": {
                        "revision": None,
                        "pending": True,
                        "summary": body.get("summary"),
                        "state": body.get("state"),
                    },
                    "pending": True,
                    "source": "cache",
                    "degraded": True,
                }))
                return
            fake.saved_checkpoint = body
            self._send(200, self._envelope({
                "checkpoint": {
                    "revision": int(body.get("expectedRevision") or fake.checkpoint_revision),
                    "summary": body.get("summary"),
                    "state": body.get("state"),
                },
                "source": "cloud",
            }))
            return
        self._error(404, "not_found")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse.urlsplit(self.path)
        body = self._body()
        fake = self.server.fake
        fake.record("POST", parsed.path, body, self.headers, parsed.query)
        if parsed.path.startswith("/runtime/v1/"):
            fake.legacy_requests.append(parsed.path)
            self._error(404, "legacy_route_removed")
            return
        if parsed.path == f"{API}/context":
            if fake.mode == "slow":
                time.sleep(fake.delay)
            if fake.mode == "error":
                self._error(fake.error_status, fake.error_code)
                return
            if fake.context_missing:
                self._error(404, "not_found", "context route missing")
                return
            blocks = [
                (dict(text) if isinstance(text, dict) else
                 {"kind": "fragment", "content": text, "trust": "untrusted"})
                for text in fake.context_blocks
            ]
            self._send(200, self._envelope({
                "recallId": "rr_test",
                "fragments": fake.fragments,
                "blocks": blocks,
                "records": [],
                "citations": [],
                "estimatedTokens": 10,
                "estimatedBytes": 100,
                "truncated": False,
                "degraded": False,
                "warnings": [],
                "silenceReason": None if blocks else "no_hits",
                "traceId": "tr_test",
                "timing": {"cueMs": 1, "fuzzyMs": 1, "expandMs": 1,
                           "assembleMs": 1, "totalMs": 4},
            }))
            return
        if parsed.path == f"{API}/recall":
            if fake.mode == "slow":
                time.sleep(fake.delay)
            if fake.mode == "error":
                self._error(fake.error_status, fake.error_code)
                return
            self._send(200, self._envelope({
                "recallId": "rr_test",
                "fragments": fake.fragments,
                "records": fake.recall_records,
                "citations": [],
                "estimatedTokens": 10,
                "estimatedBytes": 100,
                "truncated": False,
                "degraded": False,
                "warnings": [],
                "silenceReason": None,
                "traceId": "tr_test",
                "timing": {"cueMs": 1, "fuzzyMs": 1, "expandMs": 1,
                           "assembleMs": 1, "totalMs": 4},
            }))
            return
        if parsed.path.startswith(f"{API}/recall/") and parsed.path.endswith("/expand"):
            fake.expand_requests.append(body)
            if fake.mode == "error":
                self._error(fake.error_status, fake.error_code)
                return
            self._send(200, self._envelope(fake.expand_response))
            return
        if parsed.path == f"{API}/ingest":
            fake.ingests.append(body)
            if fake.mode == "slow":
                time.sleep(fake.delay)
            if fake.ingest_delay:
                time.sleep(fake.ingest_delay)
            if fake.mode == "error":
                self._error(fake.error_status, fake.error_code)
                return
            request_id = str(body.get("requestId") or "")
            duplicate = request_id in fake.seen
            fake.seen.add(request_id)
            fake.ingest_duplicates.append(duplicate)
            self._send(200, self._envelope({
                "accepted": {"chunks": len(body.get("chunks") or []),
                             "records": len(body.get("candidates") or [])},
                "records": [],
                "duplicate": duplicate,
                "warnings": [],
            }))
            return
        self._error(404, "not_found")


class _FakeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple) -> None:
        super().__init__(address, _Handler)
        self.fake = self


class FakeSidecar:
    def __init__(self) -> None:
        self.httpd = _FakeServer(("127.0.0.1", 0))
        self.httpd.fake = self  # type: ignore[attr-defined]
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self.thread.start()
        self.mode = "ok"
        self.delay = 0.0
        self.ingest_delay = 0.0
        self.error_status = 503
        self.error_code = "runtime_not_ready"
        self.retry_after = ""
        self.context_missing = False
        self.context_blocks: List[str] = []
        self.fragments: List[Dict[str, Any]] = []
        self.recall_records: List[Dict[str, Any]] = []
        self.requests: List[Dict[str, Any]] = []
        self.ingests: List[Dict[str, Any]] = []
        self.checkpoint_puts: List[Dict[str, Any]] = []
        self.saved_checkpoint: Optional[Dict[str, Any]] = None
        self.checkpoint_revision = 1
        self.checkpoint_conflict = False
        self.checkpoint_always_conflict = False
        self.checkpoint_pending = False
        self.ingest_duplicates: List[bool] = []
        self.expand_requests: List[Dict[str, Any]] = []
        self.expand_response: Dict[str, Any] = {"detail": None}
        self.legacy_requests: List[str] = []
        self.seen: set[str] = set()

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def api_url(self) -> str:
        return f"{self.url}{API}"

    def record(self, method: str, path: str, body: Dict[str, Any],
               headers: Any = None, query: str = "") -> None:
        self.requests.append({
            "method": method,
            "path": path,
            "query": query,
            "body": body,
            "authorization": ((headers.get("Authorization") or "") if headers is not None else ""),
            "idempotency": ((headers.get("Idempotency-Key") or "") if headers is not None else ""),
        })

    def paths(self) -> List[str]:
        return [entry["path"] for entry in self.requests]

    def reset(self) -> None:
        self.mode = "ok"
        self.delay = 0.0
        self.ingest_delay = 0.0
        self.error_status = 503
        self.error_code = "runtime_not_ready"
        self.retry_after = ""
        self.context_missing = False
        self.context_blocks = []
        self.fragments = []
        self.recall_records = []
        self.requests.clear()
        self.ingests.clear()
        self.checkpoint_puts.clear()
        self.saved_checkpoint = None
        self.checkpoint_revision = 1
        self.checkpoint_conflict = False
        self.checkpoint_always_conflict = False
        self.checkpoint_pending = False
        self.ingest_duplicates.clear()
        self.expand_requests.clear()
        self.expand_response = {"detail": None}
        self.legacy_requests.clear()
        self.seen.clear()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=1.0)


class BaseCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        base = Path(self.tempdir.name)
        self.hermes_home = base / "hermes"
        self.mebular_home = base / "mebular"
        self.hermes_home.mkdir(parents=True)
        self.mebular_home.mkdir(parents=True)
        self.env_patch = mock.patch.dict(
            os.environ,
            {"HERMES_HOME": str(self.hermes_home)},
            clear=False,
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        for key in (
            "MEBULAR_HOME",
            "MEBULAR_MEMORY_RUNTIME_HOME",
            "MEBULAR_MEMORY_RUNTIME_URL",
            "MEBULAR_MEMORY_RUNTIME_TOKEN",
            "MEBULAR_RUNTIME_URL",
            "MEBULAR_RUNTIME_TOKEN",
            "MEBULAR_RUNTIME_SCHEME",
            "MEBULAR_RUNTIME_NAMESPACE",
            "MEBULAR_MEMORY_DOMAIN",
            "MEBULAR_MEMORY_AGENT_ID",
            "MEBULAR_MEMORY_EXTRACTOR",
            "MEBULAR_MEMORY_SYNC",
            "MEBULAR_MEMORY_ARCHIVE",
            "MEBULAR_MEMORY_RECALL_LIMIT",
            "MEBULAR_MEMORY_RECALL_TIMEOUT",
            "MEBULAR_MEMORY_INGEST_TIMEOUT",
            "MEBULAR_MEMORY_CHECKPOINT_TIMEOUT",
            "MEBULAR_MEMORY_QUEUE_LIMIT",
            "MEBULAR_COMPANION_ENABLED",
        ):
            os.environ.pop(key, None)
        os.environ["MEBULAR_HOME"] = str(self.mebular_home)
        self.providers: List[Any] = []
        self.servers: List[FakeSidecar] = []
        self.host_token = "host-token-test"

    def tearDown(self) -> None:
        for provider in reversed(self.providers):
            try:
                provider.shutdown()
            except Exception:
                pass
        for server in self.servers:
            server.close()

    def fake_server(self) -> FakeSidecar:
        server = FakeSidecar()
        self.servers.append(server)
        return server

    def write_token_file(self, token: Optional[str] = None, mode: int = 0o600) -> Path:
        directory = self.mebular_home / "memory-runtime"
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        path = directory / "host-token"
        path.write_text((token or self.host_token) + "\n", encoding="utf-8")
        os.chmod(path, mode)
        return path

    def write_discovery(self, server: FakeSidecar, **extra: Any) -> Path:
        token_file = self.write_token_file()
        record = {
            "schema": 1,
            "kind": "mebular-memory-runtime",
            "pid": os.getpid(),
            "host": "127.0.0.1",
            "port": server.httpd.server_address[1],
            "url": server.api_url,
            "healthUrl": f"{server.api_url}/health",
            "profileId": "default",
            "runtimeVersion": "0.3.0",
            "apiVersion": 1,
            "capabilityApiVersion": 1,
            "state": "ready",
            "degraded": False,
            "tokenFile": str(token_file),
            "capabilities": {"ingest": True, "recall": True, "context": True,
                             "checkpoint": True},
            "updatedAt": int(time.time() * 1000),
        }
        record.update(extra)
        path = self.mebular_home / "memory-runtime.json"
        path.write_text(json.dumps(record), encoding="utf-8")
        return path

    def write_memory_config(self, server: FakeSidecar, **extra: Any) -> None:
        config = {"runtime_url": server.url, "recall_timeout": 0.5, "ingest_timeout": 0.5}
        config.update(extra)
        (self.hermes_home / "mebular-memory.json").write_text(
            json.dumps(config), encoding="utf-8"
        )

    def make_provider(self, server: FakeSidecar, *, discovery: bool = False,
                      **extra: Any) -> Any:
        if discovery:
            self.write_discovery(server, **extra.pop("discovery_extra", {}))
            config = dict(extra)
            if config:
                (self.hermes_home / "mebular-memory.json").write_text(
                    json.dumps(config), encoding="utf-8"
                )
        else:
            self.write_memory_config(server, **extra)
        provider = memory_plugin.MebularMemoryProvider()
        provider.initialize("s1", hermes_home=str(self.hermes_home), platform="cli",
                            agent_context="primary")
        self.providers.append(provider)
        return provider

    @staticmethod
    def wait_until(predicate: Callable[[], bool], timeout: float = 2.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return predicate()

    @property
    def spool_path(self) -> Path:
        return self.hermes_home / "mebular-memory" / "queue.jsonl"

    @property
    def dead_spool_path(self) -> Path:
        return self.hermes_home / "mebular-memory" / "dead.jsonl"

    @staticmethod
    def read_jsonl(path: Path) -> List[Dict[str, Any]]:
        if not path.exists():
            return []
        records: List[Dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(json.loads(line))
        return records


class DiscoveryTests(BaseCase):
    def test_is_available_reads_sidecar_discovery_only(self) -> None:
        provider = memory_plugin.MebularMemoryProvider()
        self.assertFalse(provider.is_available())

        # The MCP daemon's runtime.json is not a sidecar discovery file.
        (self.mebular_home / "runtime.json").write_text(
            json.dumps({"http": {"host": "127.0.0.1", "port": 7331}}),
            encoding="utf-8",
        )
        self.assertFalse(provider.is_available())

        server = self.fake_server()
        self.write_discovery(server)
        with mock.patch.object(
            memory_plugin.urlrequest, "urlopen", side_effect=AssertionError("network")
        ):
            self.assertTrue(provider.is_available())
        self.assertEqual(provider.pending(), 0)

    def test_explicit_runtime_url_wins_over_env_and_discovery(self) -> None:
        explicit = self.fake_server()
        env_server = self.fake_server()
        discovery_server = self.fake_server()
        self.write_discovery(discovery_server)
        self.write_memory_config(explicit)
        with mock.patch.dict(os.environ, {"MEBULAR_MEMORY_RUNTIME_URL": env_server.url}):
            provider = memory_plugin.MebularMemoryProvider()
            provider.initialize("s1", hermes_home=str(self.hermes_home))
            self.providers.append(provider)
            self.assertEqual(provider._base_url, explicit.api_url)
            explicit.context_blocks = ["explicit memory"]
            self.assertIn("explicit memory", provider.prefetch("hello"))
        self.assertEqual(env_server.requests, [])
        self.assertEqual(discovery_server.requests, [])

    def test_env_url_used_when_config_is_empty(self) -> None:
        env_server = self.fake_server()
        discovery_server = self.fake_server()
        self.write_discovery(discovery_server)
        with mock.patch.dict(os.environ, {"MEBULAR_MEMORY_RUNTIME_URL": env_server.url}):
            provider = memory_plugin.MebularMemoryProvider()
            provider.initialize("s1", hermes_home=str(self.hermes_home))
            self.providers.append(provider)
            self.assertEqual(provider._base_url, env_server.api_url)
        self.assertEqual(discovery_server.requests, [])

    def test_stale_or_wrong_discovery_is_rejected(self) -> None:
        server = self.fake_server()
        self.write_discovery(server, updatedAt=int(time.time() * 1000) - 60_000)
        self.assertFalse(memory_plugin.MebularMemoryProvider().is_available())

        self.write_discovery(server, kind="something-else")
        self.assertFalse(memory_plugin.MebularMemoryProvider().is_available())

        self.write_discovery(server, state="starting")
        self.assertFalse(memory_plugin.MebularMemoryProvider().is_available())

    def test_explicit_home_does_not_fall_back_to_default(self) -> None:
        with mock.patch.dict(
            os.environ, {"MEBULAR_MEMORY_RUNTIME_HOME": str(self.mebular_home)}
        ):
            server = self.fake_server()
            self.write_discovery(server)
            self.assertTrue(memory_plugin.MebularMemoryProvider().is_available())

    def test_non_loopback_http_is_rejected(self) -> None:
        with mock.patch.dict(
            os.environ, {"MEBULAR_MEMORY_RUNTIME_URL": "http://192.0.2.5:7341"}
        ):
            provider = memory_plugin.MebularMemoryProvider()
            self.assertFalse(provider.is_available())
            self.assertEqual(provider.unavailable_reason(), "runtime_insecure_url")

    def test_light_mode_and_missing_discovery_make_no_request(self) -> None:
        server = self.fake_server()
        self.write_discovery(server, mode="mcp")
        provider = memory_plugin.MebularMemoryProvider()
        provider.initialize("s1", hermes_home=str(self.hermes_home))
        self.providers.append(provider)
        self.assertFalse(provider.is_available())
        self.assertEqual(provider.prefetch("hello"), "")
        provider.sync_turn("hello", "hi", session_id="s1")
        provider.on_pre_compress([
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ])
        self.assertEqual(server.requests, [])

        (self.mebular_home / "memory-runtime.json").unlink()
        missing = memory_plugin.MebularMemoryProvider()
        missing.initialize("s1", hermes_home=str(self.hermes_home))
        self.providers.append(missing)
        self.assertEqual(missing.prefetch("hello"), "")
        missing.sync_turn("hello", "hi", session_id="s1")
        self.assertEqual(server.requests, [])

    def test_context_capability_false_disables_recall_only(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(
            server,
            discovery=True,
            discovery_extra={
                "capabilities": {"ingest": True, "recall": False, "context": False,
                                 "checkpoint": True},
            },
        )
        self.assertEqual(provider.prefetch("hello"), "")
        self.assertEqual(server.requests, [])
        provider.sync_turn("remember the dark theme", "noted", session_id="s1")
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertTrue(any(entry["path"] == f"{API}/ingest" for entry in server.requests))


class TokenTests(BaseCase):
    def test_token_file_is_used_and_insecure_file_is_ignored(self) -> None:
        server = self.fake_server()
        server.context_blocks = ["token memory"]
        provider = self.make_provider(server, discovery=True)
        provider.prefetch("hello")
        self.assertTrue(server.requests)
        self.assertEqual(
            server.requests[-1]["authorization"], f"Bearer {self.host_token}"
        )

        self.write_token_file(mode=0o644)
        server.requests.clear()
        second = memory_plugin.MebularMemoryProvider()
        second.initialize("s1", hermes_home=str(self.hermes_home))
        self.providers.append(second)
        second.prefetch("hello")
        self.assertTrue(server.requests)
        self.assertEqual(server.requests[-1]["authorization"], "")

    def test_env_token_overrides_token_file(self) -> None:
        server = self.fake_server()
        self.write_discovery(server)
        server.context_blocks = ["token memory"]
        with mock.patch.dict(os.environ, {"MEBULAR_MEMORY_RUNTIME_TOKEN": "env-token"}):
            provider = memory_plugin.MebularMemoryProvider()
            provider.initialize("s1", hermes_home=str(self.hermes_home))
            self.providers.append(provider)
            provider.prefetch("hello")
        self.assertEqual(server.requests[-1]["authorization"], "Bearer env-token")

    def test_legacy_runtime_token_is_not_read(self) -> None:
        server = self.fake_server()
        self.write_discovery(server)
        server.context_blocks = ["token memory"]
        with mock.patch.dict(os.environ, {"MEBULAR_RUNTIME_TOKEN": "legacy-token"}):
            provider = memory_plugin.MebularMemoryProvider()
            provider.initialize("s1", hermes_home=str(self.hermes_home))
            self.providers.append(provider)
            provider.prefetch("hello")
        self.assertEqual(
            server.requests[-1]["authorization"], f"Bearer {self.host_token}"
        )


class ProviderTests(BaseCase):
    def test_prefetch_context_injection(self) -> None:
        server = self.fake_server()
        server.context_blocks = ["[F1] kind=fact owner=user domain=user\ngist: User prefers dark theme"]
        provider = self.make_provider(server)
        output = provider.prefetch("theme preference")
        self.assertIn("<mebular_memory", output)
        self.assertIn('trust="untrusted"', output)
        self.assertIn('purpose="background"', output)
        self.assertIn("User prefers dark theme", output)
        self.assertTrue(output.endswith("</mebular_memory>"))
        request = server.requests[-1]
        self.assertEqual(request["path"], f"{API}/context")
        self.assertEqual(request["body"]["agentId"], "hermes")
        self.assertEqual(request["body"]["threadId"], "s1")
        self.assertEqual(request["body"]["turnKind"], "human")
        self.assertEqual(request["body"]["maxBytes"], 8192)
        status = provider.recall_status()
        self.assertIsNotNone(status)
        self.assertEqual(status.count, 1)
        self.assertFalse(server.legacy_requests)

    def test_context_detail_block_and_expand_use_sidecar(self) -> None:
        server = self.fake_server()
        server.context_blocks = [{
            "kind": "fragment",
            "content": "[F1] kind=fact owner=user domain=user\ngist: User prefers dark theme",
            "detail": {"text": "我默认用深色主题。", "format": "verbatim"},
        }]
        server.expand_response = {
            "recallId": "rr_test",
            "fragmentId": "mf_1",
            "detail": {
                "id": "det_1",
                "kind": "detail_record",
                "detailKind": "raw_chunk",
                "format": "verbatim",
                "text": "我默认用深色主题。",
                "availability": ["available"],
            },
            "degraded": False,
            "warnings": [],
        }
        provider = self.make_provider(server)
        output = provider.prefetch("我原话怎么说的？")
        self.assertIn("detail: 我默认用深色主题。", output)
        expanded = provider.expand_detail("rr_test", "mf_1", max_bytes=1024)
        self.assertTrue(expanded["ok"])
        self.assertEqual(expanded["detail"]["text"], "我默认用深色主题。")
        self.assertEqual(server.expand_requests[-1]["fragmentId"], "mf_1")
        self.assertFalse(any(entry["path"].endswith("/detail")
                             for entry in server.requests))

    def test_legacy_capture_and_enable_fields_do_not_control_behaviour(self) -> None:
        server = self.fake_server()
        self.write_discovery(server)
        self.write_memory_config(
            server, capture="off", enabled=False, sync_enabled=False,
            archive_enabled=False,
        )
        provider = self.make_provider(server)
        provider.sync_turn("remember this", "noted", session_id="s1")
        self.assertTrue(provider.flush(timeout=2.0))
        ingest = [entry for entry in server.requests if entry["path"] == f"{API}/ingest"]
        self.assertTrue(ingest)
        self.assertNotIn("capture", ingest[-1]["body"])

    def test_prefetch_empty(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        self.assertEqual(provider.prefetch("nothing"), "")
        self.assertEqual(server.paths(), [f"{API}/context"])

    def test_prefetch_timeout_returns_empty(self) -> None:
        server = self.fake_server()
        server.mode = "slow"
        server.delay = 1.0
        provider = self.make_provider(server, recall_timeout=0.2)
        started = time.monotonic()
        self.assertEqual(provider.prefetch("slow query"), "")
        self.assertLess(time.monotonic() - started, 0.9)

    def test_prefetch_falls_back_to_recall_fragments(self) -> None:
        server = self.fake_server()
        server.context_missing = True
        server.fragments = [{
            "id": "mf1",
            "kind": "fact",
            "gist": "User prefers dark theme",
            "owner": {"role": "user", "domain": "user"},
            "confidence": 0.9,
            "citations": [{"id": "r1", "type": "fact"}],
            "trust": "untrusted",
        }]
        provider = self.make_provider(server)
        output = provider.prefetch("theme")
        self.assertIn("User prefers dark theme", output)
        self.assertIn(f"{API}/context", server.paths())
        self.assertIn(f"{API}/recall", server.paths())

    def test_queue_prefetch_warms_cache(self) -> None:
        server = self.fake_server()
        server.context_blocks = ["cached memory"]
        provider = self.make_provider(server)
        provider.queue_prefetch("theme")
        self.assertTrue(self.wait_until(lambda: len(server.requests) == 1))
        output = provider.prefetch("theme")
        self.assertIn("cached memory", output)
        self.assertEqual(len(server.requests), 1)

    def test_sync_turn_idempotent_and_tool_calls(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        messages = [
            {"role": "user", "content": "check weather"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city":"SF"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "sunny"},
            {"role": "assistant", "content": "It is sunny."},
        ]
        provider.sync_turn("check weather", "It is sunny.", session_id="s1", messages=messages)
        provider.sync_turn("check weather", "It is sunny.", session_id="s1", messages=messages)
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual(len(server.ingests), 2)
        request_ids = [body["requestId"] for body in server.ingests]
        self.assertEqual(len(set(request_ids)), 1)
        self.assertTrue(server.ingest_duplicates[-1])
        body = server.ingests[0]
        self.assertTrue(body["requestId"].startswith("hermes_turn_"))
        self.assertEqual(body["threadId"], "s1")
        self.assertEqual(body["source"], "host")
        self.assertNotIn("capture", body)
        self.assertFalse(body["allowRemote"])
        self.assertEqual(body["actor"], {"type": "agent", "agentId": "hermes"})
        self.assertNotIn("sync", body)
        self.assertNotIn("/runtime/v1", server.paths())
        texts = "\n".join(chunk.get("text", "") for chunk in body["chunks"])
        self.assertIn("get_weather", texts)
        self.assertTrue(any(chunk.get("role") == "tool" and "sunny" in chunk.get("text", "")
                            for chunk in body["chunks"]))

    def test_configured_domain_is_sent_not_namespace(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server, domain="notes")
        provider.sync_turn("one", "two", session_id="s1")
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual(server.ingests[0]["domain"], "notes")
        self.assertNotIn("namespace", server.ingests[0])

    def test_session_switch_flushes_and_rebinds(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        provider.sync_turn("one", "two", session_id="s1")
        provider.on_session_switch(
            "s2",
            parent_session_id="parent",
            reset=True,
            rewound=False,
            additive_future_field="ignored",
        )
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual([body["threadId"] for body in server.ingests], ["s1"])
        provider.sync_turn("three", "four", session_id="s2")
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual([body["threadId"] for body in server.ingests], ["s1", "s2"])

    def test_pre_compress_archives_and_writes_state_only_checkpoint(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        messages = [
            {"role": "system", "content": "secret host prompt"},
            {"role": "user", "content": "remember this"},
            {"role": "assistant", "content": "noted"},
        ]
        self.assertEqual(provider.on_pre_compress(messages), "")
        self.assertTrue(provider.flush(timeout=2.0))
        first = server.ingests[0]
        self.assertTrue(first["requestId"].startswith("hermes_compress"))
        self.assertNotIn("capture", first)
        archived = "\n".join(c["text"] for c in first["chunks"])
        self.assertIn("remember this", archived)
        self.assertNotIn("secret host prompt", archived)
        self.assertTrue(server.checkpoint_puts)
        checkpoint = server.checkpoint_puts[0]
        self.assertEqual(checkpoint["agentId"], "hermes")
        self.assertEqual(checkpoint["threadId"], "s1")
        self.assertEqual(checkpoint["domain"], "task:s1")
        self.assertIsNone(checkpoint["summary"])
        self.assertEqual(checkpoint["recordIds"], [])
        self.assertEqual(checkpoint["state"]["kind"], "pre_compress")
        self.assertEqual(checkpoint["state"]["messageCount"], 3)
        self.assertIn("transcriptHash", checkpoint["state"])
        self.assertEqual(checkpoint["warning"], "summary_unavailable")
        self.assertNotIn("sync", checkpoint)
        self.assertEqual(provider.checkpoint_pending(), 0)

        self.assertEqual(provider.on_pre_compress(messages), "")
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual(server.ingests[1]["requestId"], first["requestId"])
        self.assertTrue(server.ingest_duplicates[1])
        self.assertEqual(
            server.checkpoint_puts[1]["requestId"],
            server.checkpoint_puts[0]["requestId"],
        )

    def test_checkpoint_failure_stays_pending_and_retries(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        server.mode = "error"
        self.assertEqual(provider.on_pre_compress([{"role": "user", "content": "x"}]), "")
        self.assertGreaterEqual(provider.checkpoint_pending(), 1)
        server.mode = "ok"
        self.assertTrue(provider.flush(timeout=5.0))
        self.assertEqual(provider.checkpoint_pending(), 0)
        self.assertTrue(server.checkpoint_puts)

    def test_checkpoint_revision_conflict_retries_once(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        server.checkpoint_conflict = True
        server.checkpoint_revision = 3
        provider.on_pre_compress([{"role": "user", "content": "x"}])
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertGreaterEqual(len(server.checkpoint_puts), 2)
        self.assertEqual(server.checkpoint_puts[-1]["expectedRevision"], 3)
        self.assertIn(f"{API}/checkpoints/s1", server.paths())
        self.assertEqual(provider.checkpoint_pending(), 0)

    def test_session_end_snapshot(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        provider.on_session_end([{"role": "user", "content": "bye"},
                                 {"role": "assistant", "content": "see you"}])
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertTrue(server.ingests)
        self.assertTrue(server.ingests[-1]["requestId"].startswith("hermes_session-end"))
        self.assertEqual(server.checkpoint_puts, [])

    def test_shutdown_bounded_flush(self) -> None:
        server = self.fake_server()
        server.ingest_delay = 0.2
        provider = self.make_provider(server)
        provider.sync_turn("bye", "see you", session_id="s1")
        started = time.monotonic()
        provider.shutdown()
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 3.0)
        self.assertEqual(provider.pending(), 0)
        self.assertTrue(server.ingests)

    def test_failed_ingest_spools_and_replays(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        server.mode = "error"
        started = time.monotonic()
        provider.sync_turn("one", "two", session_id="s1")
        self.assertLess(time.monotonic() - started, 0.5)  # sync_turn is non-blocking
        self.assertFalse(provider.flush(timeout=0.5))
        self.assertGreaterEqual(provider.pending(), 1)
        spool_path = self.hermes_home / "mebular-memory" / "queue.jsonl"
        self.assertEqual(stat.S_IMODE(spool_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(spool_path.parent.stat().st_mode), 0o700)

        server.mode = "ok"
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual(provider.pending(), 0)
        self.assertTrue(server.ingests)

    def test_spool_is_bounded(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server, queue_limit=10)
        server.mode = "error"
        for index in range(20):
            provider._enqueue({"requestId": f"req_{index}", "chunks": []})
        self.assertLessEqual(provider.pending(), 10)

    def test_pre_compress_failure_returns_empty_and_spools(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        server.mode = "error"
        started = time.monotonic()
        self.assertEqual(
            provider.on_pre_compress([{"role": "user", "content": "before compression"}]),
            "",
        )
        self.assertLess(time.monotonic() - started, 2.5)
        self.assertGreaterEqual(provider.pending(), 1)
        self.assertGreaterEqual(provider.checkpoint_pending(), 1)

    def test_spool_survives_new_provider(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        server.mode = "error"
        provider.sync_turn("one", "two", session_id="s1")
        self.assertFalse(provider.flush(timeout=0.4))
        self.assertGreaterEqual(provider.pending(), 1)
        provider.shutdown()
        self.assertGreaterEqual(provider.pending(), 1)

        server.mode = "ok"
        second = memory_plugin.MebularMemoryProvider()
        second.initialize("s1", hermes_home=str(self.hermes_home), platform="cli",
                          agent_context="primary")
        self.providers.append(second)
        self.assertTrue(second.flush(timeout=2.0))
        self.assertEqual(second.pending(), 0)

    def test_non_primary_context_does_not_write(self) -> None:
        server = self.fake_server()
        self.write_memory_config(server)
        provider = memory_plugin.MebularMemoryProvider()
        provider.initialize("s1", hermes_home=str(self.hermes_home), platform="cron",
                            agent_context="cron")
        self.providers.append(provider)
        provider.sync_turn("one", "two", session_id="s1")
        provider.on_pre_compress([{"role": "user", "content": "one"}])
        self.assertTrue(provider.flush(timeout=0.3))
        self.assertEqual(server.ingests, [])
        self.assertEqual(server.checkpoint_puts, [])

    def test_no_tools(self) -> None:
        self.assertEqual(memory_plugin.MebularMemoryProvider().get_tool_schemas(), [])

    def test_builtin_memory_write_is_not_mirrored(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        provider.on_memory_write("add", "memory", "built-in fact")
        provider.on_memory_write("replace", "user", "built-in profile")
        self.assertTrue(provider.flush(timeout=0.3))
        self.assertEqual(server.ingests, [])

    def test_save_config_never_persists_token(self) -> None:
        provider = memory_plugin.MebularMemoryProvider()
        provider.save_config(
            {"runtime_url": "http://127.0.0.1:7341", "token": "do-not-write",
             "domain": "notes", "namespace": "legacy"},
            str(self.hermes_home),
        )
        saved = json.loads((self.hermes_home / "mebular-memory.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["runtime_url"], "http://127.0.0.1:7341")
        self.assertEqual(saved["domain"], "notes")
        self.assertNotIn("token", saved)

    def test_status_never_exposes_token(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server, discovery=True)
        status = provider.get_status_config()
        self.assertTrue(status["tokenConfigured"])
        self.assertEqual(status["tokenSource"], "tokenFile")
        serialized = json.dumps(status)
        self.assertNotIn(self.host_token, serialized)
        self.assertEqual(status["apiVersion"], "1")
        self.assertEqual(status["features"]["checkpoints"], True)


class SpoolContractTests(BaseCase):
    def test_spool_redacts_and_minimises_before_disk_and_network(self) -> None:
        server = self.fake_server()
        server.mode = "error"
        provider = self.make_provider(server, sync_max_attempts=20, ingest_timeout=0.2)
        secret = "SENTINEL-SECRET-1234567890"
        text = (
            f"Authorization: Bearer sk-live-{secret}\n"
            f"api_key={secret}\n"
            f"password={secret.lower()}\n"
            f"ghp_{'A1B2C3D4E5F6G7H8I9J0K1L2'}\n"
            f"密码：{secret}"
        )
        provider.sync_turn(text, "noted", session_id="s1")
        provider._enqueue({
            "requestId": "minimise-1",
            "agentId": "hermes",
            "chunks": [{
                "role": "user",
                "text": "ordinary text",
                "contentHash": "not-a-hash",
                "secretExtra": secret,
            }],
            "extra": secret,
            "apiToken": secret,
        })
        self.assertTrue(self.wait_until(lambda: provider.pending() >= 2, timeout=2.0))
        self.assertTrue(self.wait_until(lambda: bool(server.ingests), timeout=2.0))
        raw = self.spool_path.read_text(encoding="utf-8")
        self.assertNotIn(secret, raw)
        self.assertNotIn(secret.lower(), raw)
        self.assertNotIn("A1B2C3D4E5F6G7H8I9J0K1L2", raw)
        self.assertIn("[redacted]", raw)

        records = self.read_jsonl(self.spool_path)
        for record in records:
            self.assertLessEqual(set(record), {
                "id", "kind", "payload", "attempts", "createdAt", "expiresAt",
                "lastError",
            })
            self.assertIn("id", record)
            self.assertIn(record["kind"], {"ingest", "checkpoint"})
            payload = record["payload"]
            self.assertNotIn("extra", payload)
            self.assertNotIn("apiToken", payload)
            if record["kind"] == "ingest":
                for chunk in payload.get("chunks") or []:
                    self.assertNotIn("secretExtra", chunk)
                    expected = hashlib.sha256(chunk["text"].encode("utf-8")).hexdigest()
                    self.assertEqual(chunk["contentHash"], f"sha256:{expected}")

        self.assertTrue(server.ingests)
        sent = json.dumps(server.ingests, ensure_ascii=False)
        self.assertNotIn(secret, sent)
        self.assertNotIn(secret.lower(), sent)
        self.assertNotIn(secret, json.dumps(provider.get_status_config(), ensure_ascii=False))

        # The exported sentinel must not be recoverable from any plugin file.
        for path in (self.hermes_home / "mebular-memory").glob("*"):
            if path.is_file():
                self.assertNotIn(secret, path.read_text(encoding="utf-8", errors="ignore"))

    def test_spool_permissions_capacity_and_status_counts(self) -> None:
        server = self.fake_server()
        server.mode = "error"
        provider = self.make_provider(server, queue_limit=3, sync_max_attempts=20)
        for index in range(6):
            provider._enqueue({"requestId": f"capacity-{index}", "chunks": []})
        self.assertLessEqual(provider.pending(), 3)
        self.assertEqual(stat.S_IMODE(self.spool_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.spool_path.parent.stat().st_mode), 0o700)
        status = provider.get_status_config()
        self.assertEqual(status["spool"]["limit"], 3)
        self.assertEqual(status["spool"]["retentionDays"], 30)
        self.assertGreaterEqual(status["spool"]["rejected"], 3)
        self.assertLessEqual(status["counts"]["spoolPending"], 3)
        self.assertGreater(status["counts"]["spoolBytes"], 0)
        # Rejecting new work keeps the oldest bounded evidence instead of
        # silently evicting it.
        first = self.read_jsonl(self.spool_path)[0]
        self.assertEqual(first["payload"]["requestId"], "capacity-0")

    def test_spool_expiry_uses_30_days_or_earlier_deadline(self) -> None:
        now = int(time.time() * 1000)
        day = 24 * 60 * 60 * 1000
        directory = self.hermes_home / "mebular-memory"
        directory.mkdir(parents=True)
        records = [
            {
                "id": "expired-30d",
                "kind": "ingest",
                "payload": {"requestId": "r-30d", "chunks": []},
                "attempts": 0,
                "createdAt": now - 31 * day,
                "expiresAt": now - day,
            },
            {
                "id": "expired-deadline",
                "kind": "ingest",
                "payload": {"requestId": "r-deadline", "chunks": []},
                "attempts": 0,
                "createdAt": now,
                "expiresAt": now - 1000,
            },
        ]
        self.spool_path.write_text(
            "\n".join(json.dumps(record) for record in records) + "\n",
            encoding="utf-8",
        )
        spool = memory_plugin._Spool(self.spool_path, 100)
        self.assertEqual(spool.depth(), 0)
        self.assertEqual(spool.dead_count(), 2)
        self.assertEqual(spool.last_dead_reason(), "retention_expired")
        self.assertEqual(stat.S_IMODE(self.spool_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.dead_spool_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.dead_spool_path.parent.stat().st_mode), 0o700)
        dead_ids = {record["id"] for record in self.read_jsonl(self.dead_spool_path)}
        self.assertEqual(dead_ids, {"expired-30d", "expired-deadline"})

    def test_checkpoint_pending_persists_and_replays_with_stable_id(self) -> None:
        server = self.fake_server()
        server.mode = "error"
        provider = self.make_provider(server, sync_max_attempts=20)
        messages = [
            {"role": "user", "content": "checkpoint pending"},
            {"role": "assistant", "content": "noted"},
        ]
        provider.on_pre_compress(messages)
        self.assertGreaterEqual(provider.checkpoint_pending(), 1)
        records = [record for record in self.read_jsonl(self.spool_path)
                   if record["kind"] == "checkpoint"]
        self.assertEqual(len(records), 1)
        item_id = records[0]["id"]
        request_id = records[0]["payload"]["requestId"]
        provider.shutdown()

        # Re-open while still offline: the same persisted item must be visible.
        second = self.make_provider(server, sync_max_attempts=20)
        self.assertGreaterEqual(second.checkpoint_pending(), 1)
        reopened = [record for record in self.read_jsonl(self.spool_path)
                    if record["kind"] == "checkpoint"]
        self.assertEqual(reopened[0]["id"], item_id)
        server.mode = "ok"
        server.checkpoint_puts.clear()
        self.assertTrue(second.flush(timeout=3.0))
        self.assertEqual(second.checkpoint_pending(), 0)
        self.assertTrue(any(body["requestId"] == request_id
                            for body in server.checkpoint_puts))
        self.assertIsNotNone(server.saved_checkpoint)

    def test_checkpoint_202_removes_host_copy_without_claiming_commit(self) -> None:
        server = self.fake_server()
        server.checkpoint_pending = True
        provider = self.make_provider(server)
        self.assertEqual(provider.on_pre_compress([
            {"role": "user", "content": "handoff"},
        ]), "")
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertTrue(server.checkpoint_puts)
        self.assertEqual(provider.checkpoint_pending(), 0)
        self.assertIsNone(server.saved_checkpoint)
        status = provider.get_status_config()
        self.assertEqual(status["counts"]["checkpointHandoffs"], 1)
        self.assertEqual(status["lastWarning"]["code"], "checkpoint_queued_outbox")
        self.assertFalse(any(record["kind"] == "checkpoint"
                             for record in self.read_jsonl(self.spool_path)))

    def test_checkpoint_pending_is_not_reported_when_spool_write_fails(self) -> None:
        server = self.fake_server()
        server.mode = "error"
        provider = self.make_provider(server, sync_max_attempts=20)
        with mock.patch.object(
            provider._spool,
            "append",
            side_effect=memory_plugin._SpoolUnavailable("disk full"),
        ):
            provider.on_pre_compress([{"role": "user", "content": "no durable spool"}])
        self.assertEqual(provider.checkpoint_pending(), 0)
        self.assertGreaterEqual(provider.get_status_config()["counts"]["checkpointFailures"], 1)
        self.assertEqual(
            provider.get_status_config()["lastWarning"]["code"],
            "checkpoint_persist_failed",
        )

    def test_sync_max_attempts_is_a_terminal_bound(self) -> None:
        server = self.fake_server()
        server.mode = "error"
        server.error_status = 503
        server.error_code = "runtime_not_ready"
        provider = self.make_provider(server, sync_max_attempts=2, ingest_timeout=0.2)
        provider.sync_turn("bounded", "retry", session_id="s1")
        self.assertTrue(self.wait_until(
            lambda: provider.get_status_config()["counts"]["spoolDead"] >= 1,
            timeout=5.0,
        ))
        self.assertEqual(provider.pending(), 0)
        dead = self.read_jsonl(self.dead_spool_path)
        self.assertEqual(len(dead), 1)
        self.assertEqual(dead[0]["attempts"], 2)
        self.assertEqual(dead[0]["reason"], "runtime_not_ready:max_attempts")
        status = provider.get_status_config()
        self.assertEqual(status["counts"]["spoolDead"], 1)
        self.assertEqual(status["spool"]["lastDeadReason"], "runtime_not_ready:max_attempts")

    def test_401_is_bounded_and_does_not_grow_pending_forever(self) -> None:
        server = self.fake_server()
        server.mode = "error"
        server.error_status = 401
        server.error_code = "unauthorized"
        provider = self.make_provider(server, sync_max_attempts=2, ingest_timeout=0.2)
        provider.sync_turn("auth one", "no", session_id="s1")
        self.assertTrue(self.wait_until(
            lambda: provider.get_status_config()["counts"]["spoolDead"] >= 1,
            timeout=5.0,
        ))
        self.assertEqual(provider.pending(), 0)
        # Each worker attempt performs one token-refresh retry, then stops.
        self.assertLessEqual(len(server.ingests), 4)
        provider.sync_turn("auth two", "no", session_id="s1")
        self.assertTrue(self.wait_until(
            lambda: provider.get_status_config()["counts"]["spoolDead"] >= 2,
            timeout=5.0,
        ))
        self.assertEqual(provider.pending(), 0)
        self.assertLessEqual(len(server.ingests), 8)

    def test_429_retry_after_is_not_a_tight_loop(self) -> None:
        server = self.fake_server()
        server.mode = "error"
        server.error_status = 429
        server.error_code = "rate_limited"
        server.retry_after = "1"
        provider = self.make_provider(server, sync_max_attempts=5, ingest_timeout=0.2)
        provider.sync_turn("rate limited", "wait", session_id="s1")
        self.assertTrue(self.wait_until(lambda: len(server.ingests) >= 1, timeout=2.0))
        first_count = len(server.ingests)
        time.sleep(0.3)
        self.assertEqual(len(server.ingests), first_count)
        self.assertGreaterEqual(provider.pending(), 1)

    def test_mode_mismatch_does_not_grow_spool_or_retry_forever(self) -> None:
        server = self.fake_server()
        server.mode = "error"
        server.error_status = 409
        server.error_code = "mode_mismatch"
        provider = self.make_provider(server, sync_max_attempts=5)
        provider.sync_turn("disabled one", "no", session_id="s1")
        self.assertTrue(self.wait_until(
            lambda: "modeBlocked" in provider.get_status_config(),
            timeout=3.0,
        ))
        # The triggering pending item is retained, not retried or deleted.
        self.assertEqual(provider.pending(), 1)
        requests_after_disable = len(server.ingests)
        checkpoint_puts_after_disable = len(server.checkpoint_puts)
        for index in range(10):
            provider.sync_turn(f"disabled {index}", "no", session_id="s1")
        provider.on_pre_compress([{"role": "user", "content": "disabled checkpoint"}])
        time.sleep(0.3)
        self.assertEqual(provider.pending(), 1)
        self.assertEqual(provider.checkpoint_pending(), 0)
        self.assertEqual(len(server.ingests), requests_after_disable)
        self.assertEqual(len(server.checkpoint_puts), checkpoint_puts_after_disable)
        status = provider.get_status_config()
        self.assertEqual(status["counts"]["spoolPending"], 1)
        self.assertEqual(status["counts"]["spoolDead"], 0)
        self.assertIn("modeBlocked", status)

    def test_mode_mismatch_recovers_on_fresh_active_discovery(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server, discovery=True, sync_max_attempts=5)
        server.mode = "error"
        server.error_status = 409
        server.error_code = "mode_mismatch"
        provider.sync_turn("disabled", "no", session_id="s1")
        self.assertTrue(self.wait_until(
            lambda: "modeBlocked" in provider.get_status_config(),
            timeout=3.0,
        ))
        self.assertEqual(provider.pending(), 1)

        server.mode = "ok"
        self.write_discovery(server, updatedAt=int(time.time() * 1000) + 1000)
        provider._ensure_runtime(force=True)
        self.assertNotIn("modeBlocked", provider.get_status_config())
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual(provider.pending(), 0)
        self.assertTrue(server.ingests)

    def test_queued_checkpoint_revision_conflict_never_rebases(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        server.checkpoint_always_conflict = True
        payload = provider._checkpoint_payload(
            [{"role": "user", "content": "queued revision"}], kind="pre_compress"
        )
        provider._spool.append("checkpoint", payload)
        provider._wake.set()
        self.assertTrue(self.wait_until(
            lambda: provider.get_status_config()["counts"]["spoolDead"] >= 1,
            timeout=3.0,
        ))
        checkpoint_gets = [
            entry for entry in server.requests
            if entry["method"] == "GET" and entry["path"].startswith(f"{API}/checkpoints/")
        ]
        self.assertEqual(checkpoint_gets, [])
        dead = self.read_jsonl(self.dead_spool_path)
        self.assertEqual(dead[-1]["reason"], "revision_mismatch")

    def test_native_memory_files_are_never_modified(self) -> None:
        memory_file = self.hermes_home / "MEMORY.md"
        user_file = self.hermes_home / "USER.md"
        memory_file.write_text("# Native memory\n- keep me\n", encoding="utf-8")
        user_file.write_text("# Native user\n- keep me too\n", encoding="utf-8")
        before = {
            path: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (memory_file, user_file)
        }
        server = self.fake_server()
        provider = self.make_provider(server)
        provider.on_memory_write("add", "memory", "mirrored?")
        provider.on_memory_write("replace", "user", "mirrored?")
        provider.sync_turn("ordinary turn", "noted", session_id="s1")
        provider.on_pre_compress([{"role": "user", "content": "compress me"}])
        self.assertTrue(provider.flush(timeout=2.0))
        provider.shutdown()
        after = {
            path: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (memory_file, user_file)
        }
        self.assertEqual(before, after)


class CompanionTests(BaseCase):
    class _Llm:
        def __init__(self) -> None:
            self.calls: List[Dict[str, Any]] = []

        def complete_structured(self, **kwargs: Any) -> Any:
            self.calls.append(kwargs)
            return types.SimpleNamespace(
                parsed={
                    "candidates": [
                        {
                            "kind": "preference",
                            "data": {
                                "entity": "user",
                                "preferenceType": "theme",
                                "value": "dark",
                                "confidence": 0.9,
                            },
                            "tags": ["ui"],
                        },
                        {
                            "kind": "fact",
                            "data": {"subject": "user", "predicate": "timezone", "object": "PT"},
                        },
                    ]
                },
                text="",
                model="host/test-model",
                usage={},
                provider="host",
            )

    class _Ctx:
        def __init__(self) -> None:
            self.llm = CompanionTests._Llm()
            self.hooks: Dict[str, Callable[..., Any]] = {}

        def register_hook(self, name: str, callback: Callable[..., Any]) -> None:
            self.hooks[name] = callback

    def _config(self, server: Optional[FakeSidecar], enabled: bool = True,
                **extra: Any) -> None:
        config: Dict[str, Any] = {"enabled": enabled}
        if server is not None:
            config["runtime_url"] = server.url
        config.update(extra)
        (self.hermes_home / "mebular-companion.json").write_text(
            json.dumps(config), encoding="utf-8"
        )

    def _run_hook(self, ctx: "CompanionTests._Ctx") -> None:
        hook = ctx.hooks["pre_llm_call"]
        result = hook(
            session_id="s1",
            user_message="next",
            conversation_history=[
                {"role": "user", "content": "I prefer dark mode"},
                {"role": "assistant", "content": "Noted."},
            ],
            is_first_turn=False,
            model="host/model",
            platform="cli",
        )
        self.assertIsNone(result)

    def test_companion_extracts_host_candidates(self) -> None:
        server = self.fake_server()
        self._config(server)
        ctx = self._Ctx()
        companion_plugin.register(ctx)
        self.assertIn("pre_llm_call", ctx.hooks)
        self._run_hook(ctx)
        self.assertEqual(len(ctx.llm.calls), 1)
        self.assertEqual(ctx.llm.calls[0]["purpose"], "mebular.companion.extract")
        self.assertTrue(server.ingests)
        body = server.ingests[0]
        self.assertEqual(server.paths()[-1], f"{API}/ingest")
        self.assertEqual(body["extractor"], "host")
        self.assertNotIn("capture", body)
        self.assertEqual(body["chunks"], [])
        self.assertEqual(body["actor"], {"type": "agent", "agentId": "hermes"})
        self.assertTrue(body["requestId"].startswith("hermes_comp_"))
        self.assertEqual(len(body["candidates"]), 2)
        self.assertNotIn("model", body)  # never fabricate a model field
        self.assertNotIn("sync", body)
        self.assertFalse(server.legacy_requests)

    def test_companion_config_url_wins_over_env_and_discovery(self) -> None:
        explicit = self.fake_server()
        env_server = self.fake_server()
        discovery_server = self.fake_server()
        self.write_discovery(discovery_server)
        self._config(explicit)
        with mock.patch.dict(os.environ, {"MEBULAR_MEMORY_RUNTIME_URL": env_server.url}):
            ctx = self._Ctx()
            companion_plugin.register(ctx)
            self._run_hook(ctx)
        self.assertTrue(explicit.ingests)
        self.assertEqual(env_server.requests, [])
        self.assertEqual(discovery_server.requests, [])

    def test_companion_uses_discovery_and_token_file(self) -> None:
        server = self.fake_server()
        self.write_discovery(server)
        self._config(None)
        ctx = self._Ctx()
        companion_plugin.register(ctx)
        self._run_hook(ctx)
        self.assertTrue(server.ingests)
        self.assertEqual(
            server.requests[-1]["authorization"], f"Bearer {self.host_token}"
        )

    def test_companion_disabled_registers_no_hook(self) -> None:
        server = self.fake_server()
        self._config(server, enabled=False)
        ctx = self._Ctx()
        companion_plugin.register(ctx)
        self.assertEqual(ctx.hooks, {})

    def test_companion_no_assistant_history_skips(self) -> None:
        server = self.fake_server()
        self._config(server)
        ctx = self._Ctx()
        companion_plugin.register(ctx)
        hook = ctx.hooks["pre_llm_call"]
        self.assertIsNone(hook(session_id="s1", user_message="hi",
                               conversation_history=[{"role": "user", "content": "hi"}]))
        self.assertEqual(ctx.llm.calls, [])
        self.assertEqual(server.ingests, [])


if __name__ == "__main__":
    unittest.main()

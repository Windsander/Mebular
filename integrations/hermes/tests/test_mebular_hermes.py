"""Executable tests for the Hermes Mebular integrations.

Run from the repository root:

    python3 -m unittest discover -s integrations/hermes/tests -v

The tests use only the Python standard library and a fake HTTP server; they
never touch a real Hermes profile, Mebular runtime, network, or credentials.
"""

from __future__ import annotations

import importlib.util
import json
import os
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

ROOT = Path(__file__).resolve().parents[1]
MEMORY_PLUGIN = ROOT / "mebular-memory" / "__init__.py"
COMPANION_PLUGIN = ROOT / "mebular-companion" / "__init__.py"


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


def _envelope(data: Dict[str, Any], request_id: str = "req_test") -> bytes:
    return json.dumps(
        {"ok": True, "requestId": request_id, "data": data, "warnings": []}
    ).encode("utf-8")


class _Handler(BaseHTTPRequestHandler):
    server: "_FakeServer"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            # The timeout test intentionally drops the connection.
            pass

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {}
        fake = self.server.fake
        if self.path == "/runtime/v1/recall":
            fake.recalls.append(body)
            if fake.mode == "slow":
                time.sleep(fake.delay)
            if fake.mode == "error":
                self._send(
                    503,
                    {
                        "ok": False,
                        "requestId": body.get("requestId", "req_test"),
                        "error": {
                            "code": "runtime_not_ready",
                            "message": "fake runtime down",
                            "retryable": True,
                        },
                    },
                )
                return
            records = fake.recall_records
            self._send(
                200,
                {
                    "ok": True,
                    "requestId": body.get("requestId", "req_test"),
                    "data": {
                        "records": records,
                        "total": len(records),
                        "degraded": False,
                    },
                    "warnings": [],
                },
            )
            return
        if self.path == "/runtime/v1/ingest":
            fake.ingests.append(body)
            if fake.ingest_delay:
                time.sleep(fake.ingest_delay)
            if fake.mode == "error":
                self._send(
                    503,
                    {
                        "ok": False,
                        "requestId": body.get("requestId", "req_test"),
                        "error": {
                            "code": "runtime_not_ready",
                            "message": "fake runtime down",
                            "retryable": True,
                        },
                    },
                )
                return
            request_id = str(body.get("requestId") or "")
            duplicate = request_id in fake.seen
            fake.seen.add(request_id)
            fake.ingest_duplicates.append(duplicate)
            self._send(
                200,
                {
                    "ok": True,
                    "requestId": request_id or "req_test",
                    "data": {
                        "accepted": {"chunks": len(body.get("chunks") or []), "records": 0},
                        "records": [],
                        "duplicate": duplicate,
                        "warnings": [],
                    },
                },
            )
            return
        self._send(404, {"ok": False, "error": {"code": "not_found"}})


class _FakeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple) -> None:
        super().__init__(address, _Handler)
        self.fake = self


class FakeRuntime:
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
        self.recall_records: List[Dict[str, Any]] = []
        self.recalls: List[Dict[str, Any]] = []
        self.ingests: List[Dict[str, Any]] = []
        self.ingest_duplicates: List[bool] = []
        self.seen: set[str] = set()

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def reset(self) -> None:
        self.mode = "ok"
        self.delay = 0.0
        self.ingest_delay = 0.0
        self.recall_records = []
        self.recalls.clear()
        self.ingests.clear()
        self.ingest_duplicates.clear()
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
            {
                "HERMES_HOME": str(self.hermes_home),
                "MEBULAR_HOME": str(self.mebular_home),
            },
            clear=False,
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        for key in (
            "MEBULAR_RUNTIME_URL",
            "MEBULAR_RUNTIME_TOKEN",
            "MEBULAR_RUNTIME_SCHEME",
            "MEBULAR_RUNTIME_NAMESPACE",
            "MEBULAR_MEMORY_AGENT_ID",
            "MEBULAR_MEMORY_CAPTURE",
            "MEBULAR_MEMORY_EXTRACTOR",
            "MEBULAR_MEMORY_SYNC",
            "MEBULAR_MEMORY_ARCHIVE",
            "MEBULAR_MEMORY_RECALL_LIMIT",
            "MEBULAR_MEMORY_RECALL_TIMEOUT",
            "MEBULAR_MEMORY_INGEST_TIMEOUT",
            "MEBULAR_MEMORY_QUEUE_LIMIT",
            "MEBULAR_COMPANION_ENABLED",
        ):
            os.environ.pop(key, None)
        self.providers: List[Any] = []
        self.servers: List[FakeRuntime] = []

    def tearDown(self) -> None:
        for provider in reversed(self.providers):
            try:
                provider.shutdown()
            except Exception:
                pass
        for server in self.servers:
            server.close()

    def fake_server(self) -> FakeRuntime:
        server = FakeRuntime()
        self.servers.append(server)
        return server

    def write_memory_config(self, server: FakeRuntime, **extra: Any) -> None:
        config = {"runtime_url": server.url, "recall_timeout": 0.5, "ingest_timeout": 0.5}
        config.update(extra)
        (self.hermes_home / "mebular-memory.json").write_text(
            json.dumps(config), encoding="utf-8"
        )

    def make_provider(self, server: FakeRuntime, **extra: Any) -> Any:
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


class ProviderTests(BaseCase):
    def test_is_available_reads_runtime_discovery_only(self) -> None:
        provider = memory_plugin.MebularMemoryProvider()
        self.assertFalse(provider.is_available())
        (self.mebular_home / "runtime.json").write_text(
            json.dumps({"http": {"host": "127.0.0.1", "port": 7331}}),
            encoding="utf-8",
        )
        with mock.patch.object(
            memory_plugin.urlrequest, "urlopen", side_effect=AssertionError("network")
        ):
            self.assertTrue(provider.is_available())
        # No network call was made: is_available only parsed local files.
        self.assertEqual(provider.pending(), 0)

    def test_env_url_overrides_discovery(self) -> None:
        with mock.patch.dict(os.environ, {"MEBULAR_RUNTIME_URL": "http://127.0.0.1:9"}):
            provider = memory_plugin.MebularMemoryProvider()
            self.assertTrue(provider.is_available())

    def test_prefetch_hit(self) -> None:
        server = self.fake_server()
        server.recall_records = [
            {"id": "r1", "type": "fact", "content": "User prefers dark theme", "score": 0.91}
        ]
        provider = self.make_provider(server)
        output = provider.prefetch("theme preference")
        self.assertIn("## Mebular Memory", output)
        self.assertIn("dark theme", output)
        status = provider.recall_status()
        self.assertIsNotNone(status)
        self.assertEqual(status.count, 1)
        self.assertEqual(server.recalls[0]["query"], "theme preference")
        self.assertEqual(server.recalls[0]["agentId"], "hermes")
        self.assertEqual(server.recalls[0]["threadId"], "s1")

    def test_prefetch_empty(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        self.assertEqual(provider.prefetch("nothing"), "")
        self.assertEqual(len(server.recalls), 1)

    def test_prefetch_timeout_returns_empty(self) -> None:
        server = self.fake_server()
        server.mode = "slow"
        server.delay = 1.0
        provider = self.make_provider(server, recall_timeout=0.2)
        started = time.monotonic()
        self.assertEqual(provider.prefetch("slow query"), "")
        self.assertLess(time.monotonic() - started, 0.9)

    def test_queue_prefetch_warms_cache(self) -> None:
        server = self.fake_server()
        server.recall_records = [{"id": "r1", "type": "fact", "content": "cached memory"}]
        provider = self.make_provider(server)
        provider.queue_prefetch("theme")
        self.assertTrue(self.wait_until(lambda: len(server.recalls) == 1))
        output = provider.prefetch("theme")
        self.assertIn("cached memory", output)
        self.assertEqual(len(server.recalls), 1)

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
        self.assertEqual(body["capture"], "local")
        self.assertFalse(body["allowRemote"])
        texts = "\n".join(chunk.get("text", "") for chunk in body["chunks"])
        self.assertIn("get_weather", texts)
        self.assertTrue(any(chunk.get("role") == "tool" and "sunny" in chunk.get("text", "")
                            for chunk in body["chunks"]))

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

    def test_pre_compress_archives_idempotently(self) -> None:
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
        self.assertEqual(first["capture"], "local")
        self.assertIn("remember this", "\n".join(c["text"] for c in first["chunks"]))
        self.assertNotIn("secret host prompt", "\n".join(c["text"] for c in first["chunks"]))

        self.assertEqual(provider.on_pre_compress(messages), "")
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual(server.ingests[1]["requestId"], first["requestId"])
        self.assertTrue(server.ingest_duplicates[1])

    def test_session_end_snapshot(self) -> None:
        server = self.fake_server()
        provider = self.make_provider(server)
        provider.on_session_end([{"role": "user", "content": "bye"},
                                 {"role": "assistant", "content": "see you"}])
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertTrue(server.ingests)
        self.assertTrue(server.ingests[-1]["requestId"].startswith("hermes_session-end"))

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

        server.mode = "ok"
        self.assertTrue(provider.flush(timeout=2.0))
        self.assertEqual(provider.pending(), 0)
        self.assertTrue(server.ingests)

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

    def test_prefetch_filters_internal_objects(self) -> None:
        server = self.fake_server()
        server.recall_records = [
            {"id": "c1", "type": "compact", "content": "internal summary"},
            {"id": "r1", "type": "fact", "content": "visible fact"},
        ]
        provider = self.make_provider(server)
        output = provider.prefetch("anything")
        self.assertIn("visible fact", output)
        self.assertNotIn("internal summary", output)

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
            {"runtime_url": "http://127.0.0.1:7331", "token": "do-not-write", "namespace": "notes"},
            str(self.hermes_home),
        )
        saved = json.loads((self.hermes_home / "mebular-memory.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["runtime_url"], "http://127.0.0.1:7331")
        self.assertEqual(saved["namespace"], "notes")
        self.assertNotIn("token", saved)


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

    def _config(self, server: FakeRuntime, enabled: bool = True) -> None:
        (self.hermes_home / "mebular-companion.json").write_text(
            json.dumps({"enabled": enabled, "runtime_url": server.url}),
            encoding="utf-8",
        )

    def test_companion_extracts_host_candidates(self) -> None:
        server = self.fake_server()
        self._config(server)
        ctx = self._Ctx()
        companion_plugin.register(ctx)
        self.assertIn("pre_llm_call", ctx.hooks)
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
        self.assertEqual(len(ctx.llm.calls), 1)
        self.assertEqual(ctx.llm.calls[0]["purpose"], "mebular.companion.extract")
        self.assertEqual(len(server.ingests), 1)
        body = server.ingests[0]
        self.assertEqual(body["extractor"], "host")
        self.assertEqual(body["capture"], "off")
        self.assertEqual(body["chunks"], [])
        self.assertTrue(body["requestId"].startswith("hermes_comp_"))
        self.assertEqual(len(body["candidates"]), 2)
        self.assertNotIn("model", body)  # never fabricate a model field

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

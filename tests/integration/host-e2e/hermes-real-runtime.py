#!/usr/bin/env python3
"""Drive the real Hermes MemoryProvider plugin against a real Runtime URL.

The Node host-E2E runner starts a real Memory Runtime sidecar in front of a
real Mebular Runtime HTTP server, writes a disposable Hermes profile, and
invokes this file with that profile. This script imports the same
`integrations/hermes/mebular-memory/__init__.py` that a Hermes profile would
load, uses Hermes' MemoryProvider seam, and prints one JSON observation
document. It never contacts a real LLM.

Environment expected from the runner:
  HERMES_HOME                     disposable profile
  MEBULAR_MEMORY_RUNTIME_HOME     sidecar home containing memory-runtime.json
  HERMES_E2E_CONFIG               JSON with session/query/messages

The runner deliberately does not pass MEBULAR_MEMORY_RUNTIME_TOKEN; the plugin
must read the sidecar host token from discovery tokenFile.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import types
from pathlib import Path
from typing import Any, Dict, List, Optional

MARKER = "HERMES_E2E_RESULT "

# Keep the worktree free of test-generated __pycache__ under integrations/.
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
        return threading.Thread(
            target=target, name=name, args=args, kwargs=kwargs or {}, daemon=daemon
        )

    memory_provider.MemoryProvider = MemoryProvider  # type: ignore[attr-defined]
    memory_provider.spawn_context_thread = spawn_context_thread  # type: ignore[attr-defined]
    sys.modules["agent"] = agent
    sys.modules["agent.memory_provider"] = memory_provider


def load_plugin() -> Any:
    plugin_path = Path(__file__).resolve().parents[3] / "integrations" / "hermes" / "mebular-memory" / "__init__.py"
    spec = importlib.util.spec_from_file_location("mebular_memory_real_runtime", plugin_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {plugin_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["mebular_memory_real_runtime"] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    install_hermes_stub()
    plugin = load_plugin()
    config = json.loads(os.environ["HERMES_E2E_CONFIG"])
    hermes_home = Path(os.environ["HERMES_HOME"])

    provider = plugin.MebularMemoryProvider()
    provider.initialize(
        config["session_id"],
        hermes_home=str(hermes_home),
        platform="cli",
        agent_context="primary",
    )

    result: Dict[str, Any] = {
        "available": bool(provider.is_available()),
        "tools": provider.get_tool_schemas(),
        "systemPrompt": provider.system_prompt_block(),
        "status": provider.get_status_config(),
    }

    result["prefetch"] = provider.prefetch(config["query"])
    result["prefetchSecond"] = provider.prefetch(config["query"])
    if config.get("detail_query"):
        result["detailPrefetch"] = provider.prefetch(config["detail_query"])
    if config.get("checkpoint_query"):
        result["checkpointPrefetch"] = provider.prefetch(config["checkpoint_query"])

    messages = [
        {"role": "user", "content": config["turn_user"]},
        {"role": "assistant", "content": config["turn_assistant"]},
    ]
    provider.sync_turn(
        config["turn_user"],
        config["turn_assistant"],
        session_id=config["session_id"],
        messages=messages,
    )
    result["turnFlushed"] = bool(provider.flush(timeout=8.0))
    result["turnPending"] = int(provider.pending())

    archive_messages = [
        {"role": "system", "content": config["secret_system_prompt"]},
        {"role": "user", "content": config["compress_user"]},
        {"role": "assistant", "content": config["compress_assistant"]},
    ]
    if config.get("skip_pre_compress") is True:
        result["preCompressReturn"] = ""
        result["compressFlushed"] = True
        result["compressPending"] = int(provider.pending())
        result["checkpointPending"] = int(provider.checkpoint_pending())
    else:
        result["preCompressReturn"] = provider.on_pre_compress(archive_messages)
        result["compressFlushed"] = bool(provider.flush(timeout=8.0))
        result["compressPending"] = int(provider.pending())
        result["checkpointPending"] = int(provider.checkpoint_pending())

    provider.on_session_switch(config["next_session_id"], reset=True)
    provider.sync_turn(
        config["next_turn_user"],
        config["next_turn_assistant"],
        session_id=config["next_session_id"],
        messages=[
            {"role": "user", "content": config["next_turn_user"]},
            {"role": "assistant", "content": config["next_turn_assistant"]},
        ],
    )
    result["switchFlushed"] = bool(provider.flush(timeout=8.0))
    result["switchPending"] = int(provider.pending())

    provider.shutdown()
    result["pendingAfterShutdown"] = int(provider.pending())
    print(MARKER + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # keep the runner's failure readable
        print(MARKER + json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        raise

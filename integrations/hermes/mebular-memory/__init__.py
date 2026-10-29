"""Mebular memory provider for Hermes Agent (0.3 Memory Runtime contract).

This is a *directory* memory provider: Hermes discovers it under
``$HERMES_HOME/plugins/<name>/`` and activates it with ``memory.provider``.
Install the directory as ``plugins/mebular`` so the directory name and the
provider name agree (Hermes resolves providers by directory name).

Design rules
------------
* Hermes' built-in ``MEMORY.md`` / ``USER.md`` stay native.  This provider
  never imports them and deliberately does not implement ``on_memory_write``
  (no mirror, no dual write).
* No tools are exposed (``get_tool_schemas() == []``).  Mebular's MCP server
  remains the explicit governance surface (writes, search, admin, skills).
* Recall goes to ``POST /runtime/v1/recall``; turn/archive capture goes to
  ``POST /runtime/v1/ingest`` on the local 0.3 Runtime.  No Mebular TypeScript
  code is imported and no host LLM credential is read.
* ``prefetch`` and ``sync_turn`` never raise and never block the agent for
  long.  Failed recall returns ``""``; failed ingest is written to a durable
  per-profile spool and retried by a daemon worker.

The provider intentionally does **not** claim to know the host's current
conversation model.  The Hermes ``MemoryProvider`` interface does not expose
it, so ingest always uses ``source=host`` plus a configured extractor
(``heuristic`` by default) and never fabricates a model name.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib import error as urlerror
from urllib import request as urlrequest

try:  # Hermes always provides this inside the host process.
    from agent.memory_provider import MemoryProvider
except Exception:  # pragma: no cover - only used by standalone test harnesses
    class MemoryProvider:  # type: ignore[no-redef]
        """Minimal fallback so the module can be inspected outside Hermes."""

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

try:
    from agent.memory_provider import RecallStatus
except Exception:  # pragma: no cover
    RecallStatus = None  # type: ignore[assignment]

logger = logging.getLogger("mebular.hermes.memory")

PROVIDER_NAME = "mebular"
DEFAULT_AGENT_ID = "hermes"
USER_AGENT = "mebular-hermes-memory/0.3.0"

_INTERNAL_TYPES = frozenset(
    {"compact", "context_checkpoint", "self_record", "raw_chunk", "recall_trace"}
)
_RESERVED_NAMESPACE_PREFIX = "__"
_AGENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_THREAD_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_CHOICE_CAPTURE = ("off", "local")
# The provider always sends allowRemote=false, so api extraction is not a
# usable choice here; host extraction belongs to the optional companion.
_CHOICE_EXTRACTOR = ("heuristic", "local", "auto")

_MAX_CHUNKS = 100
# 60k chars is < 256 KiB even for 4-byte UTF-8 text.  The request-level byte
# cap keeps the whole body comfortably under the contract's 2 MiB limit.
_MAX_CHUNK_CHARS = 60_000
_MAX_TOTAL_BYTES = 1_700_000
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_QUEUE_LIMIT_DEFAULT = 100
_PREFETCH_CACHE_LIMIT = 64
_RECALL_FAILURE_COOLDOWN = 30.0
_DUPLICATE_SYNC_WINDOW = 5.0

# Server errors that will not become true by retrying the same request.
_NON_RETRYABLE_CODES = frozenset(
    {
        "invalid_request",
        "invalid_agent_id",
        "invalid_thread_id",
        "namespace_reserved",
        "content_hash_mismatch",
        "unauthorized",
        "forbidden_scope",
        "agent_scope_forbidden",
        "mode_mismatch",
        "cloud_mismatch",
        "payload_too_large",
        "extraction_invalid",
        "remote_not_allowed",
    }
)

_DEFAULT_CONFIG: Dict[str, Any] = {
    "runtime_url": "",
    "agent_id": DEFAULT_AGENT_ID,
    "namespace": "",
    "capture": "local",
    "extractor": "heuristic",
    "sync_enabled": True,
    "archive_enabled": True,
    "recall_limit": 8,
    "recall_token_budget": 2000,
    "recall_timeout": 1.5,
    "ingest_timeout": 3.0,
    "archive_flush_timeout": 1.5,
    "sync_max_attempts": 12,
    "queue_limit": _QUEUE_LIMIT_DEFAULT,
}

_PERSISTED_KEYS = tuple(_DEFAULT_CONFIG.keys())


class _RuntimeError(RuntimeError):
    """A non-2xx or transport failure from the Runtime API (content-free)."""

    def __init__(self, code: str, message: str = "", *, status: Optional[int] = None,
                 retryable: bool = True) -> None:
        super().__init__(message or code)
        self.code = str(code or "runtime_error")
        self.status = status
        self.retryable = retryable


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()


def _clean_text(value: Any, limit: int = _MAX_CHUNK_CHARS) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    text = text.replace("\x00", "")
    return text[:limit]


def _content_text(content: Any) -> str:
    """Flatten OpenAI-style content (str or multimodal parts) to safe text.

    Images and other binary parts are replaced with a marker; they are never
    base64-encoded into the Runtime request.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        kind = str(content.get("type") or "")
        if kind in {"", "text", "input_text"} and isinstance(content.get("text"), str):
            return content["text"]
        return _clean_text(content)
    if isinstance(content, list):
        parts: List[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
                continue
            if not isinstance(part, dict):
                continue
            kind = str(part.get("type") or "")
            if kind in {"text", "input_text"}:
                parts.append(_clean_text(part.get("text")))
            elif kind in {"image_url", "image", "input_image", "audio", "input_audio", "file"}:
                parts.append(f"[{kind} omitted]")
            elif isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(p for p in parts if p)
    if content is None:
        return ""
    return _clean_text(content)


def _tool_call_text(message: Dict[str, Any]) -> str:
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return ""
    lines: List[str] = []
    for call in calls:
        if not isinstance(call, dict):
            continue
        function = call.get("function") if isinstance(call.get("function"), dict) else {}
        name = function.get("name") or call.get("name") or "tool"
        arguments = function.get("arguments", call.get("arguments", ""))
        if not isinstance(arguments, str):
            try:
                arguments = json.dumps(arguments, ensure_ascii=False, default=str)
            except Exception:
                arguments = str(arguments)
        lines.append(f"[tool_call] {name}({arguments[:4000]})")
    return "\n".join(lines)


def _message_text(message: Dict[str, Any]) -> str:
    text = _content_text(message.get("content"))
    tool_calls = _tool_call_text(message)
    if tool_calls:
        text = f"{text}\n{tool_calls}" if text else tool_calls
    return text.strip()


def _message_at(message: Dict[str, Any], fallback: int) -> int:
    for key in ("timestamp", "at", "created_at", "createdAt"):
        value = message.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            number = float(value)
            return int(number * 1000) if number < 10_000_000_000 else int(number)
        if isinstance(value, str) and value.strip():
            stripped = value.strip()
            try:
                if re.fullmatch(r"\d+(?:\.\d+)?", stripped):
                    number = float(stripped)
                    return int(number * 1000) if number < 10_000_000_000 else int(number)
                parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return int(parsed.timestamp() * 1000)
            except Exception:
                continue
    return fallback


def _chunks_from_messages(messages: Iterable[Any], *, request_id: str, now: int) -> List[Dict[str, Any]]:
    chunks: List[Dict[str, Any]] = []
    if not isinstance(messages, (list, tuple)):
        return chunks
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").lower()
        if role not in {"user", "assistant", "system", "tool"}:
            continue
        # The host system prompt is not conversation evidence and can contain
        # private operator instructions; do not archive it.
        if role == "system":
            continue
        text = _message_text(message)
        if not text:
            continue
        at = _message_at(message, now)
        base_id = str(message.get("id") or message.get("message_id") or f"{request_id[:16]}-{index}")
        pieces = [text[i:i + _MAX_CHUNK_CHARS] for i in range(0, len(text), _MAX_CHUNK_CHARS)] or [text]
        for piece_index, piece in enumerate(pieces):
            message_id = f"{base_id}:{piece_index}" if len(pieces) > 1 else base_id
            chunks.append(
                {
                    "role": role,
                    "text": piece,
                    "at": at,
                    "messageId": message_id,
                    "contentHash": f"sha256:{_sha256_text(piece)}",
                }
            )
    if len(chunks) > _MAX_CHUNKS:
        # Ingest caps a request at 100 chunks.  For an archive, the most recent
        # evidence is the useful part; earlier chunks stay in the host transcript
        # or already went through sync_turn.
        chunks = chunks[-_MAX_CHUNKS:]
    total_bytes = sum(
        len((chunk.get("text") or "").encode("utf-8", "replace")) for chunk in chunks
    )
    if total_bytes > _MAX_TOTAL_BYTES:
        # Keep the newest text that fits; a long archive is better represented
        # by the recent end than by a 413.
        kept: List[Dict[str, Any]] = []
        used = 0
        for chunk in reversed(chunks):
            length = len((chunk.get("text") or "").encode("utf-8", "replace"))
            if kept and used + length > _MAX_TOTAL_BYTES:
                break
            kept.append(chunk)
            used += length
        chunks = list(reversed(kept))
    return chunks


def _turn_messages(messages: Any, user_content: str, assistant_content: str) -> List[Dict[str, Any]]:
    selected: List[Dict[str, Any]] = []
    if isinstance(messages, (list, tuple)) and messages:
        start = 0
        for index in range(len(messages) - 1, -1, -1):
            item = messages[index]
            if isinstance(item, dict) and str(item.get("role") or "") == "user":
                start = index
                break
        selected = [item for item in messages[start:] if isinstance(item, dict)]
    if not selected:
        if user_content:
            selected.append({"role": "user", "content": user_content})
        if assistant_content:
            selected.append({"role": "assistant", "content": assistant_content})
        return selected

    has_user = any(
        str(item.get("role") or "") == "user" and _message_text(item) for item in selected
    )
    has_assistant = any(
        str(item.get("role") or "") == "assistant" and _message_text(item) for item in selected
    )
    if user_content and not has_user:
        selected.insert(0, {"role": "user", "content": user_content})
    if assistant_content and not has_assistant:
        selected.append({"role": "assistant", "content": assistant_content})
    return selected


def _normalise_url(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    url = value.strip().rstrip("/")
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return ""


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _fallback_hermes_home() -> Path:
    """Profile home when a caller has not passed ``hermes_home`` yet."""
    env_home = os.environ.get("HERMES_HOME", "").strip()
    if env_home:
        return Path(env_home).expanduser()
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        return Path(get_hermes_home()).expanduser()
    except Exception:
        return Path.home() / ".hermes"


def _atomic_write_json(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    data = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary.write_text(data, encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    os.replace(temporary, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _coerce_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return default


def _coerce_int(value: Any, default: int, *, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except Exception:
        return default
    return max(minimum, min(maximum, number))


def _coerce_float(value: Any, default: float, *, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except Exception:
        return default
    return max(minimum, min(maximum, number))


def _valid_agent_id(value: Any) -> str:
    candidate = str(value or "").strip().lower()
    return candidate if _AGENT_ID_RE.fullmatch(candidate) else DEFAULT_AGENT_ID


def _valid_namespace(value: Any) -> str:
    candidate = str(value or "").strip()
    if not candidate or candidate.startswith(_RESERVED_NAMESPACE_PREFIX):
        return ""
    return candidate[:128]


def _load_plugin_config(hermes_home: Optional[Path]) -> Dict[str, Any]:
    config = dict(_DEFAULT_CONFIG)
    if hermes_home is not None:
        raw = _read_json(hermes_home / "mebular-memory.json")
        for key in _PERSISTED_KEYS:
            if key in raw:
                config[key] = raw[key]

    env = os.environ
    overrides = {
        "runtime_url": env.get("MEBULAR_RUNTIME_URL"),
        "agent_id": env.get("MEBULAR_MEMORY_AGENT_ID"),
        "namespace": env.get("MEBULAR_RUNTIME_NAMESPACE"),
        "capture": env.get("MEBULAR_MEMORY_CAPTURE"),
        "extractor": env.get("MEBULAR_MEMORY_EXTRACTOR"),
        "sync_enabled": env.get("MEBULAR_MEMORY_SYNC"),
        "archive_enabled": env.get("MEBULAR_MEMORY_ARCHIVE"),
        "recall_limit": env.get("MEBULAR_MEMORY_RECALL_LIMIT"),
        "recall_timeout": env.get("MEBULAR_MEMORY_RECALL_TIMEOUT"),
        "ingest_timeout": env.get("MEBULAR_MEMORY_INGEST_TIMEOUT"),
        "queue_limit": env.get("MEBULAR_MEMORY_QUEUE_LIMIT"),
    }
    for key, value in overrides.items():
        if value is not None and str(value).strip() != "":
            config[key] = value

    config["runtime_url"] = _normalise_url(config.get("runtime_url"))
    config["agent_id"] = _valid_agent_id(config.get("agent_id"))
    config["namespace"] = _valid_namespace(config.get("namespace"))
    capture = str(config.get("capture") or "local").strip().lower()
    config["capture"] = capture if capture in _CHOICE_CAPTURE else "local"
    extractor = str(config.get("extractor") or "heuristic").strip().lower()
    config["extractor"] = extractor if extractor in _CHOICE_EXTRACTOR else "heuristic"
    config["sync_enabled"] = _coerce_bool(config.get("sync_enabled"), True)
    config["archive_enabled"] = _coerce_bool(config.get("archive_enabled"), True)
    config["recall_limit"] = _coerce_int(config.get("recall_limit"), 8, minimum=1, maximum=50)
    config["recall_token_budget"] = _coerce_int(
        config.get("recall_token_budget"), 2000, minimum=200, maximum=12000
    )
    config["recall_timeout"] = _coerce_float(
        config.get("recall_timeout"), 1.5, minimum=0.2, maximum=10.0
    )
    config["ingest_timeout"] = _coerce_float(
        config.get("ingest_timeout"), 3.0, minimum=0.3, maximum=15.0
    )
    config["archive_flush_timeout"] = _coerce_float(
        config.get("archive_flush_timeout"), 1.5, minimum=0.2, maximum=5.0
    )
    config["sync_max_attempts"] = _coerce_int(
        config.get("sync_max_attempts"), 12, minimum=1, maximum=100
    )
    config["queue_limit"] = _coerce_int(
        config.get("queue_limit"), _QUEUE_LIMIT_DEFAULT, minimum=10, maximum=5000
    )
    return config


def _get_token() -> str:
    """Read only Mebular's own runtime token, never host LLM credentials.

    Hermes setup writes secret fields to the profile's ``.env``.  Prefer the
    process environment; when Hermes' scoped secret helper is available, use
    it so multiplexed profiles resolve their own value.
    """
    token = os.environ.get("MEBULAR_RUNTIME_TOKEN", "").strip()
    if not token:
        try:
            from agent.secret_scope import get_secret  # type: ignore
            token = str(get_secret("MEBULAR_RUNTIME_TOKEN", "") or "").strip()
        except Exception:
            token = ""
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token


def _profile_homes(root: Path) -> List[Path]:
    """Best-effort profile homes for ``root``, current profile first.

    The 0.3 Runtime still follows the Mebular profile registry: a daemon may
    listen in ``<root>/profiles/<id>`` while the root itself has no runtime.json.
    """
    registry = _read_json(root / "profiles.json")
    profiles = registry.get("profiles")
    entries = [entry for entry in profiles if isinstance(entry, dict)] if isinstance(profiles, list) else []
    current = str(registry.get("current") or "")
    ordered: List[Path] = []
    if current:
        for entry in entries:
            if str(entry.get("id") or "") == current:
                home = entry.get("home")
                if isinstance(home, str) and home.strip():
                    ordered.append(root / home.strip())
                break
    ordered.append(root)
    for entry in entries:
        home = entry.get("home")
        if isinstance(home, str) and home.strip():
            ordered.append(root / home.strip())
    return ordered


def _candidate_mebular_homes() -> List[Path]:
    homes: List[Path] = []
    env_home = os.environ.get("MEBULAR_HOME", "").strip()
    if env_home:
        # An explicit home is the profile/home the caller selected; do not fall
        # through to ~/.mebular and attach to a different cloud.
        homes.append(Path(env_home).expanduser())
    else:
        homes.append(Path.home() / ".mebular")

    expanded: List[Path] = []
    for home in list(homes):
        expanded.extend(_profile_homes(home))
    seen: set[str] = set()
    unique: List[Path] = []
    for home in expanded:
        key = str(home)
        if key not in seen:
            seen.add(key)
            unique.append(home)
    return unique


def _home_scheme(home: Path) -> str:
    scheme = os.environ.get("MEBULAR_RUNTIME_SCHEME", "").strip().lower()
    if scheme in {"http", "https"}:
        return scheme
    config = _read_json(home / "config.json")
    http = config.get("mcp", {}).get("http", {}) if isinstance(config.get("mcp"), dict) else {}
    if isinstance(http, dict):
        tls = http.get("tls")
        if tls is True or str(tls).strip().lower() in {"1", "true", "yes", "on"}:
            return "https"
        if http.get("tlsKey") and http.get("tlsCert"):
            return "https"
    return "http"


def _join_host_port(host: str, port: int, scheme: str) -> str:
    safe_host = host.strip()
    if safe_host in {"0.0.0.0", "::", "[::]", "*"}:
        safe_host = "127.0.0.1"
    if ":" in safe_host and not safe_host.startswith("["):
        safe_host = f"[{safe_host}]"
    default_port = 443 if scheme == "https" else 80
    suffix = "" if port == default_port else f":{port}"
    return f"{scheme}://{safe_host}{suffix}"


def _discover_runtime(hermes_home: Optional[Path] = None) -> Dict[str, str]:
    """Read local Runtime discovery only.  No network, no token, no identity.

    Order:
      1. ``MEBULAR_RUNTIME_URL`` (explicit operator override)
      2. ``<hermes_home>/mebular-memory.json`` ``runtime_url``
      3. ``<mebular_home>/runtime.json`` written by the Mebular daemon
    """
    env_url = os.environ.get("MEBULAR_RUNTIME_URL", "").strip()
    if env_url:
        url = _normalise_url(env_url)
        if not url:
            return {"url": "", "source": "env", "reason": "MEBULAR_RUNTIME_URL is not http(s)"}
        return {"url": url, "source": "MEBULAR_RUNTIME_URL", "reason": ""}

    config_home = hermes_home if hermes_home is not None else _fallback_hermes_home()
    configured = _normalise_url(_read_json(config_home / "mebular-memory.json").get("runtime_url"))
    if configured:
        return {"url": configured, "source": str(config_home / "mebular-memory.json"), "reason": ""}

    for home in _candidate_mebular_homes():
        record = _read_json(home / "runtime.json")
        http = record.get("http")
        if not isinstance(http, dict):
            continue
        host = http.get("host")
        port_value = http.get("port")
        try:
            port = int(port_value)
        except Exception:
            continue
        if not isinstance(host, str) or not host.strip():
            continue
        if not (1 <= port <= 65535):
            continue
        scheme = str(http.get("scheme") or "").strip().lower()
        if scheme not in {"http", "https"}:
            scheme = _home_scheme(home)
        return {
            "url": _join_host_port(host, port, scheme),
            "source": str(home / "runtime.json"),
            "reason": "",
        }

    return {
        "url": "",
        "source": "",
        "reason": "Mebular runtime not discovered (start Mebular or set MEBULAR_RUNTIME_URL)",
    }


class _RuntimeClient:
    """Tiny stdlib HTTP client for the local Runtime API."""

    def __init__(self, base_url: str, token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token

    @property
    def base_url(self) -> str:
        return self._base_url

    def post(self, path: str, payload: Dict[str, Any], *,
             timeout: float, idempotency_key: str = "") -> Dict[str, Any]:
        if not self._base_url:
            raise _RuntimeError("runtime_unavailable", "runtime URL is not configured")
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urlrequest.Request(
            f"{self._base_url}{path}", data=body, headers=headers, method="POST"
        )
        try:
            with urlrequest.urlopen(request, timeout=max(0.1, float(timeout))) as response:
                raw = response.read(_MAX_RESPONSE_BYTES)
        except urlerror.HTTPError as error:
            raw = b""
            try:
                raw = error.read(_MAX_RESPONSE_BYTES)
            except Exception:
                pass
            code, message = self._error_from_body(raw, error.code)
            retryable = error.code >= 500 or error.code in {408, 425, 429}
            if code in _NON_RETRYABLE_CODES:
                retryable = False
            raise _RuntimeError(code, message, status=error.code, retryable=retryable) from None
        except (urlerror.URLError, TimeoutError, OSError, ValueError) as error:
            reason = getattr(error, "reason", None) or error
            raise _RuntimeError("runtime_unavailable", str(reason)[:300], retryable=True) from None

        try:
            parsed = json.loads(raw.decode("utf-8", "replace")) if raw else {}
        except Exception:
            raise _RuntimeError("invalid_response", "runtime returned non-JSON", retryable=True) from None
        if not isinstance(parsed, dict):
            raise _RuntimeError("invalid_response", "runtime returned a non-object", retryable=True)
        if parsed.get("ok") is False:
            error = parsed.get("error") if isinstance(parsed.get("error"), dict) else {}
            code = str(error.get("code") or "runtime_error")
            message = str(error.get("message") or "")
            retryable = error.get("retryable")
            if retryable is None:
                retryable = code not in _NON_RETRYABLE_CODES
            raise _RuntimeError(code, message[:300], retryable=bool(retryable))
        data = parsed.get("data")
        return data if isinstance(data, dict) else parsed

    @staticmethod
    def _error_from_body(raw: bytes, status: int) -> Tuple[str, str]:
        try:
            parsed = json.loads(raw.decode("utf-8", "replace")) if raw else {}
        except Exception:
            return f"http_{status}", ""
        if isinstance(parsed, dict):
            error = parsed.get("error")
            if isinstance(error, dict):
                return str(error.get("code") or f"http_{status}"), str(error.get("message") or "")[:300]
        return f"http_{status}", ""


class _Spool:
    """Small durable FIFO for failed/queued ingest requests.

    The file lives under the profile's Hermes home and contains only the
    already-built Runtime request bodies.  Writes are atomic; no token or host
    credential is ever written.
    """

    def __init__(self, path: Path, limit: int) -> None:
        self._path = path
        self._limit = max(1, int(limit))
        self._lock = threading.RLock()
        self._items: List[Dict[str, Any]] = []
        self._next_id = 1
        self._load()

    def _load(self) -> None:
        try:
            lines = self._path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return
        except Exception as error:
            logger.warning("Mebular spool unreadable (%s); starting empty", type(error).__name__)
            return
        for line in lines:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except Exception:
                continue
            if not isinstance(record, dict) or not isinstance(record.get("payload"), dict):
                continue
            record["id"] = self._next_id
            try:
                record["attempts"] = int(record.get("attempts") or 0)
            except Exception:
                record["attempts"] = 0
            self._next_id += 1
            self._items.append(record)
        if len(self._items) > self._limit:
            self._items = self._items[-self._limit:]

    def _persist_locked(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self._path.parent, 0o700)
        except OSError:
            pass
        temporary = self._path.with_name(f"{self._path.name}.tmp-{os.getpid()}")
        lines = []
        for record in self._items:
            serialisable = {key: value for key, value in record.items() if key != "id"}
            lines.append(json.dumps(serialisable, ensure_ascii=False))
        data = "\n".join(lines)
        if data:
            data += "\n"
        try:
            temporary.write_text(data, encoding="utf-8")
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, self._path)
            try:
                os.chmod(self._path, 0o600)
            except OSError:
                pass
        except Exception as error:
            logger.warning("Mebular spool write failed: %s", type(error).__name__)

    def append(self, payload: Dict[str, Any]) -> int:
        with self._lock:
            record = {
                "id": self._next_id,
                "payload": payload,
                "attempts": 0,
                "createdAt": _now_ms(),
            }
            self._next_id += 1
            self._items.append(record)
            if len(self._items) > self._limit:
                dropped = len(self._items) - self._limit
                del self._items[:dropped]
                logger.warning("Mebular spool full; dropped %d oldest request(s)", dropped)
            self._persist_locked()
            return record["id"]

    def first(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            return dict(self._items[0]) if self._items else None

    def remove(self, item_id: int) -> None:
        with self._lock:
            before = len(self._items)
            self._items = [item for item in self._items if item.get("id") != item_id]
            if len(self._items) != before:
                self._persist_locked()

    def fail(self, item_id: int) -> int:
        with self._lock:
            attempts = 0
            for item in self._items:
                if item.get("id") == item_id:
                    item["attempts"] = int(item.get("attempts") or 0) + 1
                    attempts = item["attempts"]
                    break
            self._persist_locked()
            return attempts

    def depth(self) -> int:
        with self._lock:
            return len(self._items)

    def clear(self) -> None:
        with self._lock:
            self._items = []
            self._persist_locked()


def _spawn_worker(target: Any, *, name: str, args: Tuple[Any, ...] = ()) -> threading.Thread:
    """Use Hermes' context-preserving thread helper when available.

    Background work must inherit the profile's contextvars; a bare thread on a
    multiplexed gateway can land on the default profile.  The fallback keeps
    standalone use working.
    """
    try:
        from agent.memory_provider import spawn_context_thread  # type: ignore
        return spawn_context_thread(target, name=name, args=args)
    except Exception:
        return threading.Thread(target=target, name=name, args=args, daemon=True)


class MebularMemoryProvider(MemoryProvider):
    """Hermes external memory provider backed by the local Mebular Runtime."""

    def __init__(self) -> None:
        self._hermes_home: Optional[Path] = None
        self._session_id = ""
        self._platform = ""
        self._writes_enabled = True
        self._config: Dict[str, Any] = dict(_DEFAULT_CONFIG)
        self._agent_id = DEFAULT_AGENT_ID
        self._namespace = ""
        self._base_url = ""
        self._base_url_source = ""
        self._token = ""
        self._client: Optional[_RuntimeClient] = None
        self._spool: Optional[_Spool] = None
        self._spool_home: Optional[Path] = None
        self._queue_limit = _QUEUE_LIMIT_DEFAULT
        self._recall_timeout = 1.5
        self._ingest_timeout = 3.0
        self._archive_flush_timeout = 1.5
        self._sync_max_attempts = 12
        self._sync_enabled = True
        self._archive_enabled = True
        self._capture = "local"
        self._extractor = "heuristic"
        self._recall_limit = 8
        self._recall_token_budget = 2000

        self._lock = threading.RLock()
        self._send_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._shutdown = False
        self._initialized = False

        self._prefetch_cache: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        self._prefetch_inflight: set[Tuple[str, str]] = set()
        self._prefetch_threads: List[threading.Thread] = []
        self._last_recall_count: Optional[int] = None
        self._recall_block_until = 0.0

        self._turn_seq: Dict[str, int] = {}
        self._last_sync_signature = ""
        self._last_sync_payload: Optional[Dict[str, Any]] = None
        self._last_sync_at = 0.0

    # ------------------------------------------------------------------
    # Core lifecycle
    # ------------------------------------------------------------------

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    def is_available(self) -> bool:
        """Only local Runtime discovery.  No network, no token, no identity."""
        return bool(_discover_runtime(None)["url"])

    def unavailable_reason(self) -> str:
        discovery = _discover_runtime(self._hermes_home)
        return "" if discovery["url"] else discovery["reason"]

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        # Bind the profile the manager names.  Never hardcode ~/.hermes, and
        # never rebind from a later call (multiplexed gateways share a process).
        home_value = kwargs.get("hermes_home") or os.environ.get("HERMES_HOME")
        new_home = Path(home_value).expanduser() if home_value else _fallback_hermes_home()
        if self._worker is not None and self._worker.is_alive():
            # Defensive re-initialization: stop the old worker before swapping
            # the client/spool.  Hermes normally creates a new instance instead.
            self._stop.set()
            self._wake.set()
            self._worker.join(timeout=1.0)
            self._worker = None
        self._hermes_home = new_home
        self._session_id = str(session_id or "")
        self._platform = str(kwargs.get("platform") or "")
        agent_context = str(kwargs.get("agent_context") or "primary").strip().lower()
        self._writes_enabled = agent_context in {"", "primary"}
        self._config = _load_plugin_config(self._hermes_home)
        self._agent_id = _valid_agent_id(self._config.get("agent_id"))
        self._namespace = _valid_namespace(self._config.get("namespace"))
        self._recall_timeout = float(self._config["recall_timeout"])
        self._ingest_timeout = float(self._config["ingest_timeout"])
        self._archive_flush_timeout = float(self._config["archive_flush_timeout"])
        self._sync_max_attempts = int(self._config["sync_max_attempts"])
        self._sync_enabled = bool(self._config["sync_enabled"])
        self._archive_enabled = bool(self._config["archive_enabled"])
        self._capture = str(self._config["capture"])
        self._extractor = str(self._config["extractor"])
        self._recall_limit = int(self._config["recall_limit"])
        self._recall_token_budget = int(self._config["recall_token_budget"])
        self._queue_limit = int(self._config["queue_limit"])

        discovery = _discover_runtime(self._hermes_home)
        self._base_url = discovery["url"]
        self._base_url_source = discovery["source"]
        self._token = _get_token()
        self._client = _RuntimeClient(self._base_url, self._token) if self._base_url else None

        if self._spool is None or self._spool_home != self._hermes_home:
            self._spool = _Spool(
                self._hermes_home / "mebular-memory" / "queue.jsonl", self._queue_limit
            )
            self._spool_home = self._hermes_home

        with self._lock:
            self._prefetch_cache.clear()
            self._prefetch_inflight.clear()
            self._last_recall_count = None
            self._recall_block_until = 0.0
            self._turn_seq.clear()
            self._last_sync_signature = ""
            self._last_sync_payload = None
            self._last_sync_at = 0.0
        self._shutdown = False
        self._initialized = True
        if self._client is not None:
            try:
                self._ensure_worker()
            except Exception as error:
                logger.debug("Mebular sync worker could not start: %s", type(error).__name__)
        logger.debug(
            "Mebular provider initialized (agent=%s, runtime=%s, source=%s, queue=%s)",
            self._agent_id,
            bool(self._base_url),
            self._base_url_source or "none",
            self._spool.depth() if self._spool else 0,
        )

    def system_prompt_block(self) -> str:
        if not self._base_url:
            return ""
        return (
            "# Mebular Memory\n"
            "Mebular external memory is active for this profile. Relevant long-term memory is "
            "injected automatically before a turn. Hermes' built-in MEMORY.md / USER.md remain "
            "Hermes-native; Mebular does not import or mirror them. Use the Mebular MCP tools "
            "only for explicit governance (search, write, admin); ordinary recall is automatic."
        )

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        # Deliberately empty: the 29 Mebular MCP tools remain the governance
        # surface.  A memory provider tool would duplicate the MCP contract.
        return []

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Deliberately no-op: never mirror or dual-write MEMORY.md / USER.md.

        Hermes' built-in memory stays authoritative.  Importing or mirroring it
        would create two writers for the same user facts; Mebular only receives
        conversation evidence through ``sync_turn`` / archives.  An optional
        mirror, if ever wanted, must be a separate opt-in feature.
        """
        return None

    # ------------------------------------------------------------------
    # Recall
    # ------------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._ready() or not isinstance(query, str) or not query.strip():
            return ""
        try:
            sid = str(session_id or self._session_id)
            key = (sid, _sha256_text(query.strip()))
            records = self._take_cached(key)
            if records is None:
                if self._recall_blocked():
                    return ""
                try:
                    records = self._recall(query, sid)
                except Exception as error:
                    self._note_recall_failure(error)
                    return ""
                self._note_recall_success()
            text = self._format_records(records)
            self._last_recall_count = text.count("\n- ") if text else None
            return text
        except Exception as error:
            logger.debug("Mebular prefetch failed safely: %s", type(error).__name__)
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if not self._ready() or not isinstance(query, str) or not query.strip():
            return
        try:
            sid = str(session_id or self._session_id)
            key = (sid, _sha256_text(query.strip()))
            if self._recall_blocked():
                return
            with self._lock:
                if key in self._prefetch_cache or key in self._prefetch_inflight:
                    return
                self._prefetch_inflight.add(key)
                self._prune_prefetch_threads_locked()
                if len(self._prefetch_threads) >= 4:
                    self._prefetch_inflight.discard(key)
                    return
                thread = _spawn_worker(
                    self._prefetch_worker, name="mebular-prefetch", args=(query, sid, key)
                )
                self._prefetch_threads.append(thread)
            try:
                thread.start()
            except Exception:
                with self._lock:
                    self._prefetch_inflight.discard(key)
                logger.debug("Mebular prefetch worker could not start")
        except Exception as error:
            logger.debug("Mebular queue_prefetch failed safely: %s", type(error).__name__)

    def _prefetch_worker(self, query: str, sid: str, key: Tuple[str, str]) -> None:
        records: Optional[List[Dict[str, Any]]] = None
        try:
            if not self._recall_blocked():
                records = self._recall(query, sid)
        except Exception as error:
            self._note_recall_failure(error)
        finally:
            with self._lock:
                self._prefetch_inflight.discard(key)
                if records is not None:
                    self._recall_block_until = 0.0
                    self._prefetch_cache[key] = records
                    self._trim_prefetch_cache_locked()

    def recall_status(self) -> Any:
        if RecallStatus is None or not self._last_recall_count:
            return None
        return RecallStatus("Mebular", int(self._last_recall_count))

    def _recall(self, query: str, sid: str) -> List[Dict[str, Any]]:
        if self._client is None:
            raise _RuntimeError("runtime_unavailable", "runtime URL is not configured")
        payload: Dict[str, Any] = {
            "query": query.strip()[:4000],
            "agentId": self._agent_id,
            "threadId": self._thread_id(sid),
            "limit": self._recall_limit,
            "tokenBudget": self._recall_token_budget,
            "includeHistory": False,
        }
        if self._namespace:
            payload["namespaces"] = [self._namespace]
        data = self._client.post("/runtime/v1/recall", payload, timeout=self._recall_timeout)
        records = data.get("records")
        return records if isinstance(records, list) else []

    def _take_cached(self, key: Tuple[str, str]) -> Optional[List[Dict[str, Any]]]:
        with self._lock:
            if key in self._prefetch_cache:
                return self._prefetch_cache.pop(key)
            if key in self._prefetch_inflight:
                deadline = time.monotonic() + 0.4
                while key in self._prefetch_inflight and time.monotonic() < deadline:
                    time.sleep(0.02)
                if key in self._prefetch_cache:
                    return self._prefetch_cache.pop(key)
            return None

    def _trim_prefetch_cache_locked(self) -> None:
        while len(self._prefetch_cache) > _PREFETCH_CACHE_LIMIT:
            self._prefetch_cache.pop(next(iter(self._prefetch_cache)))

    def _prune_prefetch_threads_locked(self) -> None:
        self._prefetch_threads = [thread for thread in self._prefetch_threads if thread.is_alive()]

    def _recall_blocked(self) -> bool:
        return time.monotonic() < self._recall_block_until

    def _note_recall_failure(self, error: BaseException) -> None:
        self._recall_block_until = time.monotonic() + _RECALL_FAILURE_COOLDOWN
        if isinstance(error, _RuntimeError):
            logger.debug("Mebular recall failed: %s (status=%s)", error.code, error.status)
        else:
            logger.debug("Mebular recall failed: %s", type(error).__name__)

    def _note_recall_success(self) -> None:
        self._recall_block_until = 0.0

    @staticmethod
    def _format_records(records: List[Dict[str, Any]]) -> str:
        lines: List[str] = []
        for record in records:
            if not isinstance(record, dict) or _is_internal_record(record):
                continue
            content = record.get("content")
            text = content if isinstance(content, str) else _content_text(content)
            text = re.sub(r"\s+", " ", text or "").strip()
            if not text:
                continue
            if len(text) > 400:
                text = text[:397].rstrip() + "..."
            kind = str(record.get("kind") or record.get("type") or "memory")
            score = record.get("score")
            suffix = f" (score {float(score):.2f})" if isinstance(score, (int, float)) else ""
            lines.append(f"- [{kind}] {text}{suffix}")
            if len(lines) >= 20:
                break
        if not lines:
            return ""
        return "## Mebular Memory\n" + "\n".join(lines)

    # ------------------------------------------------------------------
    # Write path
    # ------------------------------------------------------------------

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
        turn_author: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self._ready() or not self._sync_enabled or not self._writes_enabled:
            return
        try:
            self._sync_turn_impl(
                user_content,
                assistant_content,
                session_id=session_id,
                messages=messages,
                turn_author=turn_author,
            )
        except Exception as error:
            # Hermes must never see a memory-provider exception on a turn.
            logger.debug("Mebular sync_turn failed safely: %s", type(error).__name__)

    def _sync_turn_impl(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
        turn_author: Optional[Dict[str, Any]] = None,
    ) -> None:
        sid = str(session_id or self._session_id)
        selected = _turn_messages(messages, user_content or "", assistant_content or "")
        now = _now_ms()
        request_id = "pending"
        chunks = _chunks_from_messages(selected, request_id=request_id, now=now)
        if not chunks:
            return
        signature = _sha256_text(
            sid + "\x00" + "\x00".join(
                f"{chunk.get('role')}:{chunk.get('contentHash')}" for chunk in chunks
            )
        )
        monotonic_now = time.monotonic()
        with self._lock:
            if (
                signature == self._last_sync_signature
                and monotonic_now - self._last_sync_at < _DUPLICATE_SYNC_WINDOW
            ):
                # Hermes retries a turn on some failure paths; a repeat within a
                # few seconds is the same turn.  Re-enqueue the exact same
                # requestId so the Runtime's ingest idempotency (duplicate=true)
                # absorbs it instead of creating a second record.
                payload = self._last_sync_payload
            else:
                payload = None
                self._last_sync_signature = signature
                self._last_sync_at = monotonic_now
                sequence = self._turn_seq.get(sid, 0) + 1
                self._turn_seq[sid] = sequence
        if payload is not None:
            self._enqueue(payload)
            return
        request_id = self._request_id("turn", sid, sequence, signature)
        chunks = _chunks_from_messages(selected, request_id=request_id, now=now)
        payload = self._ingest_payload(
            request_id,
            sid,
            chunks,
            extractor=self._extractor,
            capture=self._capture,
        )
        with self._lock:
            self._last_sync_payload = payload
        self._enqueue(payload)

    def on_pre_compress(self, messages: List[Dict[str, Any]], **kwargs: Any) -> str:
        """Best-effort archive of the transcript before lossy compression.

        This provider keeps the inherited v1 checkpoint contract: failure never
        blocks Hermes' compression.  The archive is enqueued in the durable
        spool and a short bounded flush is attempted.
        """
        try:
            self._archive(messages, label="compress")
            if self._spool is not None and self._client is not None:
                self.flush(timeout=self._archive_flush_timeout)
        except Exception as error:
            logger.debug("Mebular pre-compress archive skipped: %s", type(error).__name__)
        return ""

    def on_session_end(self, messages: List[Dict[str, Any]], **kwargs: Any) -> None:
        if not self._ready() or not self._archive_enabled or not self._writes_enabled:
            return
        try:
            self._archive(messages, label="session-end")
            if self._spool is not None and self._client is not None:
                self.flush(timeout=self._archive_flush_timeout)
        except Exception as error:
            logger.debug("Mebular session-end snapshot skipped: %s", type(error).__name__)
        finally:
            with self._lock:
                self._prefetch_cache.clear()
                self._last_recall_count = None

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs: Any,
    ) -> None:
        """Flush the old session, then rebind per-session state.

        Accepts ``**kwargs`` because Hermes forwards additive lifecycle fields
        on this hook.  ``reset=True`` is a genuinely new conversation; the old
        queue is flushed first and prefetch state is dropped.
        """
        if not self._initialized or self._shutdown:
            self._session_id = str(new_session_id or self._session_id)
            return
        old_session_id = self._session_id
        try:
            if self._spool is not None and self._client is not None:
                self.flush(timeout=2.0)
        except Exception:
            pass
        with self._lock:
            self._session_id = str(new_session_id or self._session_id)
            self._prefetch_cache.clear()
            self._prefetch_inflight.clear()
            self._last_recall_count = None
            if reset:
                self._last_sync_signature = ""
                self._last_sync_payload = None
                self._last_sync_at = 0.0
                self._turn_seq.pop(old_session_id, None)
            if rewound:
                # The transcript was truncated; old queued writes are already
                # correctly scoped to the old message content and stay queued.
                self._last_sync_signature = ""
                self._last_sync_payload = None
                self._last_sync_at = 0.0
        logger.debug(
            "Mebular session switched (parent=%s, reset=%s, rewound=%s, extra=%s)",
            bool(parent_session_id),
            reset,
            rewound,
            sorted(kwargs),
        )

    def shutdown(self) -> None:
        """Bounded flush: stop the worker, then drain for at most ~3 seconds."""
        with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
        self._stop.set()
        self._wake.set()
        deadline = time.monotonic() + 3.0
        worker = self._worker
        if worker is not None and worker.is_alive():
            try:
                worker.join(timeout=1.5)
            except Exception:
                pass
        try:
            self._drain_blocking(deadline)
        except Exception as error:
            logger.debug("Mebular shutdown flush skipped: %s", type(error).__name__)
        for thread in list(self._prefetch_threads):
            remaining = max(0.0, deadline - time.monotonic())
            if remaining <= 0:
                break
            if thread.is_alive():
                thread.join(timeout=min(0.2, remaining))
        self._worker = None
        logger.debug("Mebular provider shut down (pending=%s)", self.pending())

    # ------------------------------------------------------------------
    # Archive / ingest helpers
    # ------------------------------------------------------------------

    def _archive(self, messages: Any, *, label: str) -> None:
        if not self._ready() or not self._archive_enabled or not self._writes_enabled:
            return
        if not isinstance(messages, (list, tuple)) or not messages:
            return
        sid = self._session_id
        now = _now_ms()
        preview = _chunks_from_messages(messages, request_id="pending", now=now)
        if not preview:
            return
        digest = _sha256_text(
            label + "\x00" + sid + "\x00" + "\x00".join(
                str(chunk.get("contentHash") or "") for chunk in preview
            )
        )
        request_id = self._request_id(label, sid, 0, digest)
        chunks = _chunks_from_messages(messages, request_id=request_id, now=now)
        self._enqueue(
            self._ingest_payload(
                request_id,
                sid,
                chunks,
                extractor=self._extractor,
                capture=self._capture,
            )
        )

    def _ingest_payload(
        self,
        request_id: str,
        sid: str,
        chunks: List[Dict[str, Any]],
        *,
        extractor: str,
        capture: str,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "requestId": request_id,
            "agentId": self._agent_id,
            "threadId": self._thread_id(sid),
            "source": "host",
            "capture": capture if capture in _CHOICE_CAPTURE else "local",
            "allowRemote": False,
            "extractor": extractor if extractor in _CHOICE_EXTRACTOR else "heuristic",
            "chunks": chunks,
        }
        if self._namespace:
            payload["namespace"] = self._namespace
        return payload

    def _request_id(self, label: str, sid: str, sequence: int, digest: str) -> str:
        raw = f"{label}\x00{self._agent_id}\x00{sid}\x00{sequence}\x00{digest}"
        safe_label = re.sub(r"[^a-z0-9_-]+", "-", label.lower()).strip("-") or "request"
        return f"hermes_{safe_label}_{_sha256_text(raw)[:32]}"

    def _thread_id(self, session_id: str) -> str:
        candidate = str(session_id or "").strip()
        if candidate and _THREAD_ID_RE.fullmatch(candidate):
            return candidate
        return "th_" + _sha256_text(candidate or "hermes-session")[:32]

    def _enqueue(self, payload: Dict[str, Any]) -> None:
        spool = self._spool
        if spool is None:
            return
        spool.append(payload)
        self._wake.set()
        if self._client is not None:
            try:
                self._ensure_worker()
            except Exception as error:
                logger.debug("Mebular sync worker could not start: %s", type(error).__name__)
        logger.debug(
            "Mebular queued ingest %s (%d chunks, pending=%d)",
            payload.get("requestId"),
            len(payload.get("chunks") or []),
            spool.depth(),
        )

    # ------------------------------------------------------------------
    # Durable worker
    # ------------------------------------------------------------------

    def _ensure_worker(self) -> None:
        with self._lock:
            if self._client is None or self._shutdown:
                return
            if self._worker is not None and self._worker.is_alive():
                self._wake.set()
                return
            self._stop.clear()
            self._wake.clear()
            self._worker = _spawn_worker(self._worker_loop, name="mebular-memory-sync")
            self._worker.start()

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            spool = self._spool
            if spool is None or self._client is None:
                return
            item = spool.first()
            if item is None:
                self._wake.wait(timeout=0.5)
                self._wake.clear()
                continue
            item_id = int(item.get("id") or 0)
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            try:
                self._send_ingest(payload)
            except _RuntimeError as error:
                if not error.retryable or error.code in _NON_RETRYABLE_CODES:
                    spool.remove(item_id)
                    logger.warning(
                        "Mebular ingest dropped a non-retryable request (%s, status=%s)",
                        error.code,
                        error.status,
                    )
                    continue
                attempts = spool.fail(item_id)
                if attempts == self._sync_max_attempts:
                    logger.warning(
                        "Mebular ingest still failing after %d attempts (%s); keeping in spool",
                        attempts,
                        error.code,
                    )
                delay = min(30.0, 0.5 * (2 ** min(attempts, 6)))
                self._wake.wait(timeout=delay)
                self._wake.clear()
                continue
            except Exception as error:
                attempts = spool.fail(item_id)
                logger.debug("Mebular ingest worker error: %s", type(error).__name__)
                self._wake.wait(timeout=min(30.0, 0.5 * (2 ** min(attempts, 6))))
                self._wake.clear()
                continue
            spool.remove(item_id)

    def _send_ingest(self, payload: Dict[str, Any]) -> None:
        client = self._client
        if client is None:
            raise _RuntimeError("runtime_unavailable", "runtime URL is not configured")
        with self._send_lock:
            client.post(
                "/runtime/v1/ingest",
                payload,
                timeout=self._ingest_timeout,
                idempotency_key=str(payload.get("requestId") or ""),
            )

    def _drain_blocking(self, deadline: float) -> None:
        spool = self._spool
        client = self._client
        if spool is None or client is None:
            return
        while time.monotonic() < deadline:
            item = spool.first()
            if item is None:
                return
            item_id = int(item.get("id") or 0)
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            try:
                self._send_ingest_until(payload, deadline)
            except _RuntimeError as error:
                if not error.retryable or error.code in _NON_RETRYABLE_CODES:
                    spool.remove(item_id)
                    continue
                return
            except Exception:
                return
            spool.remove(item_id)

    def _send_ingest_until(self, payload: Dict[str, Any], deadline: float) -> None:
        """Synchronous drain bounded by an absolute deadline (shutdown)."""
        client = self._client
        if client is None:
            raise _RuntimeError("runtime_unavailable", "runtime URL is not configured")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _RuntimeError("shutdown_deadline", "shutdown deadline elapsed")
        if not self._send_lock.acquire(timeout=max(0.05, remaining)):
            raise _RuntimeError("runtime_busy", "ingest worker still sending")
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _RuntimeError("shutdown_deadline", "shutdown deadline elapsed")
            client.post(
                "/runtime/v1/ingest",
                payload,
                timeout=max(0.1, min(self._ingest_timeout, remaining)),
                idempotency_key=str(payload.get("requestId") or ""),
            )
        finally:
            self._send_lock.release()

    def flush(self, timeout: float = 2.0) -> bool:
        """Wait until the spool is empty or *timeout* elapses (bounded)."""
        spool = self._spool
        if spool is None:
            return True
        deadline = time.monotonic() + max(0.0, float(timeout))
        self._wake.set()
        next_wake = time.monotonic() + 0.25
        while time.monotonic() < deadline:
            if spool.depth() == 0:
                return True
            if time.monotonic() >= next_wake:
                self._wake.set()
                next_wake = time.monotonic() + 0.25
            time.sleep(0.02)
        return spool.depth() == 0

    def pending(self) -> int:
        return self._spool.depth() if self._spool is not None else 0

    def _ready(self) -> bool:
        return bool(self._initialized and self._client is not None and not self._shutdown)

    # ------------------------------------------------------------------
    # Setup / diagnostics
    # ------------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "runtime_url",
                "description": "Mebular Runtime base URL (empty = read local runtime.json discovery)",
                "default": "",
            },
            {
                "key": "token",
                "description": "Mebular bearer token with memory.read + memory.write",
                "secret": True,
                "required": False,
                "env_var": "MEBULAR_RUNTIME_TOKEN",
            },
            {
                "key": "namespace",
                "description": "Optional memory namespace (empty = default; reserved __* rejected)",
                "default": "",
            },
            {
                "key": "capture",
                "description": "Raw capture policy for ingest",
                "default": "local",
                "choices": ["local", "off"],
            },
            {
                "key": "extractor",
                "description": "Runtime extraction source (heuristic is local and always available)",
                "default": "heuristic",
                "choices": ["heuristic", "local", "auto"],
            },
            {
                "key": "sync_enabled",
                "description": "Send completed turns to the Runtime",
                "default": "true",
                "choices": ["true", "false"],
            },
            {
                "key": "archive_enabled",
                "description": "Archive transcripts before compression and at session end",
                "default": "true",
                "choices": ["true", "false"],
            },
            {
                "key": "recall_limit",
                "description": "Maximum recall records per turn",
                "type": "integer",
                "default": 8,
                "minimum": 1,
                "maximum": 50,
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        home = Path(hermes_home).expanduser()
        path = home / "mebular-memory.json"
        existing = _read_json(path)
        for secret_key in ("token", "api_key", "authorization"):
            existing.pop(secret_key, None)
        for key in _PERSISTED_KEYS:
            if key == "token" or key not in values:
                continue
            existing[key] = values[key]
        _atomic_write_json(path, existing)

    def get_status_config(self, provider_config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        discovery = _discover_runtime(self._hermes_home) if not self._base_url else None
        status: Dict[str, Any] = {
            "runtime_url": self._base_url or (discovery or {}).get("url") or "(not discovered)",
            "discovery": self._base_url_source or (discovery or {}).get("source") or "(none)",
            "agent_id": self._agent_id,
            "namespace": self._namespace or "default",
            "capture": self._capture,
            "extractor": self._extractor,
            "sync": self._sync_enabled,
            "archive": self._archive_enabled,
            "pending_ingest": self.pending(),
        }
        if not self._writes_enabled:
            status["writes"] = "disabled (non-primary agent context)"
        return status


def _is_internal_record(record: Dict[str, Any]) -> bool:
    if record.get("internal") is True:
        return True
    if str(record.get("type") or "") in _INTERNAL_TYPES:
        return True
    namespace = record.get("namespace")
    if isinstance(namespace, str) and namespace.startswith(_RESERVED_NAMESPACE_PREFIX) and namespace != "__policy__":
        return True
    metadata = record.get("metadata")
    if isinstance(metadata, dict):
        runtime = metadata.get("runtime")
        if isinstance(runtime, dict) and runtime.get("internal") is True:
            return True
    return False


# Short alias for tests / callers that prefer the runtime name.
MebularProvider = MebularMemoryProvider

__all__ = ["MebularMemoryProvider", "MebularProvider", "register"]


def register(ctx: Any) -> None:
    """Hermes memory-provider entry point."""
    ctx.register_memory_provider(MebularMemoryProvider())

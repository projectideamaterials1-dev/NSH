"""
assistant/llm.py
----------------
Client for the chat model, served by Ollama (POST /api/chat). Configured from the environment:

    ASSISTANT_OLLAMA_URL   Ollama server (default http://localhost:11434; from the Docker
                           backend use http://host.docker.internal:11434)
    ASSISTANT_MODEL        model tag, e.g. qwen3:8b (default) or qwen3:4b
    ASSISTANT_KEEP_ALIVE   how long Ollama keeps the model in GPU memory after a reply (default 2m).
                           The screening engine shares the GPU, so keep this short.
    ASSISTANT_NUM_CTX      context window in tokens (default 8192)
    ASSISTANT_TIMEOUT_S    per-model-call timeout (default 180)
    ASSISTANT_MAX_STEPS    tool-call rounds per question before the model must answer (default 6)
"""
import os
from dataclasses import dataclass
from typing import List, Optional

import httpx


class ModelUnavailable(RuntimeError):
    """The model server is unreachable, the model is not installed, or the call failed."""


@dataclass(frozen=True)
class AssistantSettings:
    ollama_url: str = "http://localhost:11434"
    model: str = "qwen3:8b"
    keep_alive: str = "2m"
    num_ctx: int = 8192
    timeout_s: float = 180.0
    max_steps: int = 6

    @classmethod
    def from_env(cls) -> "AssistantSettings":
        env = os.environ.get
        return cls(
            ollama_url=env("ASSISTANT_OLLAMA_URL", cls.ollama_url).rstrip("/"),
            model=env("ASSISTANT_MODEL", cls.model),
            keep_alive=env("ASSISTANT_KEEP_ALIVE", cls.keep_alive),
            num_ctx=int(env("ASSISTANT_NUM_CTX", cls.num_ctx)),
            timeout_s=float(env("ASSISTANT_TIMEOUT_S", cls.timeout_s)),
            max_steps=int(env("ASSISTANT_MAX_STEPS", cls.max_steps)),
        )


class OllamaClient:
    def __init__(self, settings: AssistantSettings, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.settings = settings
        self._transport = transport  # tests inject httpx.MockTransport

    def _http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.settings.ollama_url, timeout=self.settings.timeout_s,
                                 transport=self._transport)

    async def chat(self, messages: List[dict], tools: Optional[List[dict]], think: bool) -> dict:
        """One model turn. Returns Ollama's assistant message: content, optional thinking and tool_calls."""
        s = self.settings
        body = {"model": s.model, "messages": messages, "stream": False, "keep_alive": s.keep_alive,
                "think": think, "options": {"num_ctx": s.num_ctx}}
        if tools:
            body["tools"] = tools
        async with self._http() as http:
            try:
                resp = await http.post("/api/chat", json=body)
                if resp.status_code == 400 and "think" in resp.text:
                    # Models without a thinking mode (e.g. llama3.1) reject the field entirely.
                    body.pop("think")
                    resp = await http.post("/api/chat", json=body)
            except httpx.HTTPError as e:
                raise ModelUnavailable(f"Model server unreachable at {s.ollama_url} ({type(e).__name__})") from e
        if resp.status_code == 404:
            raise ModelUnavailable(f"Model {s.model!r} is not installed; run `ollama pull {s.model}`")
        if resp.status_code >= 400:
            raise ModelUnavailable(f"Model server error {resp.status_code}: {resp.text[:300]}")
        return resp.json()["message"]

    async def status(self) -> dict:
        s = self.settings
        out = {"provider": "ollama", "url": s.ollama_url, "model": s.model, "reachable": False,
               "installed": False, "loaded": False}
        async with self._http() as http:
            try:
                tags = (await http.get("/api/tags")).json().get("models", [])
                running = (await http.get("/api/ps")).json().get("models", [])
            except (httpx.HTTPError, ValueError):
                return out
        names = {m.get("name") for m in tags} | {m.get("model") for m in tags}
        out.update(reachable=True, installed=s.model in names,
                   loaded=any(s.model in (m.get("name"), m.get("model")) for m in running))
        return out

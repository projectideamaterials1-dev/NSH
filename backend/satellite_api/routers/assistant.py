"""
routers/assistant.py
--------------------
Operator chat assistant (local LLM via Ollama, see satellite_api/assistant/):

  POST /api/assistant/chat     answer a question using read-only tools; returns the answer, every
                               tool call with its data, a grounding report on the answer's numbers,
                               and any proposed actions (assistant/actions.py) - which this endpoint
                               never executes; the dashboard does, after the operator confirms
  GET  /api/assistant/status   model server reachable / model installed / model loaded in GPU memory

The chat endpoint never changes mission state, so read-only API keys may use it (middleware/auth.py).
The conversation is client-held: send the history with every request.
"""
from typing import List, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from satellite_api.assistant import agent
from satellite_api.assistant.llm import AssistantSettings, ModelUnavailable, OllamaClient

router = APIRouter()


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(..., min_length=1, max_length=40)
    think: bool = Field(False, description="Let the model reason before answering: better plans, slower replies")


def get_client(request: Request) -> OllamaClient:
    # Tests (and a future cloud provider) install their own client on app.state.
    return getattr(request.app.state, "assistant_client", None) or OllamaClient(AssistantSettings.from_env())


@router.post("/api/assistant/chat", tags=["Assistant"])
async def chat(body: ChatRequest, request: Request):
    if body.messages[-1].role != "user":
        raise HTTPException(status_code=422, detail="The last message must be from the user.")
    try:
        return await agent.run(request, get_client(request), [m.model_dump() for m in body.messages], body.think)
    except ModelUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.get("/api/assistant/status", tags=["Assistant"])
async def status(request: Request):
    return await get_client(request).status()

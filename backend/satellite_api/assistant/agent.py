"""
assistant/agent.py
------------------
The tool-calling loop: the model asks for tools, we run them (read-only, tools.py; action proposals,
actions.py), feed the results back, and repeat until it answers or hits the step limit. The answer
is then checked against everything the tools returned (grounding.py), and proposed actions are
returned for the operator to confirm.
"""
import re
import time
from typing import List

from fastapi import Request

from satellite_api.assistant import grounding, tools
from satellite_api.assistant.llm import OllamaClient
from satellite_api.timeutils import iso_z

SYSTEM_PROMPT = """You are the flight-dynamics assistant for operators of a satellite constellation \
collision-avoidance system (NSH). You answer questions about conjunctions, maneuvers, the autopilot's \
decisions and the fleet.

Rules:
- Get every fact from the tools. Never calculate orbits, miss distances or collision probabilities \
yourself, and never invent numbers, ids or times.
- Quote numbers exactly as a tool returned them, with units. Write the id of the object \
(e.g. CDM-00018, RISAT-1) in the same sentence as its numbers.
- To explain why the system did something, use list_decisions (its rationale and the options it \
considered). To recommend a maneuver, use get_trade_study and compare the options against the \
no-burn baseline and the pc threshold.
- A pc at or above the threshold is critical. A pc like 1e-200 means the risk is effectively zero - \
unless pc_diluted is true: then the pc is low because the position uncertainty is large, not because \
the objects are far apart, so say the risk is uncertain and quote pc_max. If short_encounter_valid is \
false, say the 2-D pc is approximate for this slow encounter.
- If a trade study says maneuver_required is false, recommend no burn: every burn costs fuel and adds \
risk. Describe the options only as a fallback, and say so.
- Do not do arithmetic on tool values (ratios, differences, unit conversions). Quote the values instead.
- You cannot execute anything. When the operator asks you to do something (schedule a burn, approve or \
reject a proposal, change the autopilot, run screening), call the matching propose_* tool: it creates an \
action card the operator reviews and confirms. Never say an action was done; say it is ready for the \
operator to confirm, and mention any warnings the tool returned. Only propose actions the operator asked \
for or that the data clearly requires.
- When recommending a maneuver, mention that the engine is decision-support fidelity, not certified SSA.
- Questions about how reliable or accurate the numbers are: call get_physics_model. "Should I approve X?": \
call list_proposals and get_trade_study for its conjunction, then give your recommendation.
- Be concise. Use short markdown lists. Times are UTC."""

_THINK_TAGS = re.compile(r"<think>.*?</think>", re.DOTALL)

# Small models treat "what would happen if I disabled the autopilot?" as a request to disable it, so the
# propose_* tools are only offered when the operator's message asks for something to be done.
_ACTION_VERBS = r"(schedule|plan|propose|approve|reject|turn|disable|enable|run|set|switch|queue|create|execute|burn)"
_REQUEST = re.compile(rf"(^|[.!?;\n]\s*)(please\s+)?{_ACTION_VERBS}\b"
                      rf"|\b(can|could|would|will) you (please )?{_ACTION_VERBS}\b"
                      rf"|\b(please|go ahead|let'?s|i want to|i'd like to)\b", re.I)
_ADVISORY = re.compile(r"\b(what (would|will|happens?|if)|what if|should (i|we)|would it|is it (safe|wise|worth)|"
                       r"don'?t (do|change|execute|schedule|act)|do not (do|change|execute|schedule|act)|"
                       r"(do|did) we need|why|explain|recommend|advise)\b", re.I)
# Greetings and "what can you do" need no data; anything else answered without a tool is answered from memory.
_SMALL_TALK = re.compile(r"^\s*(hi|hello|hey|thanks|thank you|ok|okay|good (morning|evening))\b|what can you (help|do)", re.I)
# "The burn has been scheduled": nothing is ever executed here, only proposed.
_CLAIMS_DONE = re.compile(r"\b(has been|have been|was|were|is now|are now|successfully|I have|I've)\s+"
                          r"(scheduled|executed|approved|rejected|disabled|enabled|queued|submitted|uplinked)\b", re.I)


def wants_action(question: str) -> bool:
    """True when the operator asked for something to be done (not a hypothetical or advice question)."""
    if _REQUEST.search(question):
        return True
    return not _ADVISORY.search(question) and not question.rstrip().endswith("?")


def _not_done(answer: str) -> str:
    """Rewrites claims of execution into what actually happened: an action card awaits confirmation."""
    return _CLAIMS_DONE.sub(lambda m: f"is ready to be {m.group(2).lower()} once you confirm it", answer)


async def run(request: Request, client: OllamaClient, history: List[dict], think: bool) -> dict:
    started = time.monotonic()
    state = request.app.state.orbital_state
    now = iso_z(state.current_time) if state.is_ready() and state.current_time is not None else "not initialized"
    question = next((m["content"] for m in reversed(history) if m["role"] == "user"), "")
    allow_actions = wants_action(question)
    system = f"{SYSTEM_PROMPT}\n\nCurrent simulation time: {now}"
    if not allow_actions:
        system += ("\n\nThis message is a question, not a request: answer it, and do not offer to perform actions "
                   "unless the operator asks.")
    messages = [{"role": "system", "content": system}, *history]
    max_steps = client.settings.max_steps
    calls, results, actions, stopped = [], [], [], "answer"
    msg, nudged = {}, False
    for step in range(max_steps + 1):
        final_round = step == max_steps
        if final_round:
            messages.append({"role": "user", "content": "Tool budget used up. Answer now with the data you have."})
            stopped = "step_limit"
        msg = await client.chat(messages, None if final_round else tools.specs(allow_actions), think)
        messages.append({k: v for k, v in msg.items() if k in ("role", "content", "tool_calls")})
        requested = msg.get("tool_calls") or []
        if not requested and not calls and not nudged and not final_round and not _SMALL_TALK.search(question):
            # Answered from memory. One nudge; the eval showed qwen3:8b doing this for "how reliable ..."
            # and "should I approve ...", and the answer is then ungrounded.
            nudged = True
            messages.append({"role": "user", "content": "Answer from the tools, not from memory: call the tools that "
                                                        "hold this data first, then answer my question."})
            continue
        if not requested or final_round:
            break
        for req in requested:
            fn = req.get("function") or {}
            name, args = fn.get("name", ""), fn.get("arguments") or {}
            if name.startswith("propose_") and not allow_actions:
                outcome = {"error": "The operator asked a question, not for an action: answer it without proposing."}
            else:
                outcome = await tools.call(name, request, args)
            calls.append({"name": name, "arguments": args, **outcome})
            if "result" in outcome:
                results.append(outcome["result"])
                if isinstance(outcome["result"], dict) and "proposed_action" in outcome["result"]:
                    actions.append(outcome["result"]["proposed_action"])
            messages.append({"role": "tool", "tool_name": name, "content": tools.to_model_text(outcome)})

    answer = _THINK_TAGS.sub("", msg.get("content") or "").strip()
    if actions:
        answer = _not_done(answer)
    return {
        "answer": answer,
        "thinking": (msg.get("thinking") or "").strip() or None,
        "model": client.settings.model,
        "stopped": stopped,
        "duration_s": round(time.monotonic() - started, 2),
        "tool_calls": calls,
        "actions": actions,          # proposals only; the dashboard executes one when the operator confirms it
        "grounding": grounding.check(answer, results, question),
    }

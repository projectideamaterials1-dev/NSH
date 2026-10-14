"""
assistant/
----------
Operator chat assistant: a local LLM (Ollama) that answers questions about the mission by calling
read-only tools over the existing API handlers, then explains what the engine computed. The model
never does orbital mechanics or Pc itself, and every number in its answer is checked against the
tool data it was given (grounding.py).
"""

"""
config.py – Combined Banking Analytics + Digital Marketing Agent configuration.

LLMs:
  - Local Ollama gpt-oss:120b-cloud       → banking analytics (Engineer, Scientist, Analyst)
  - Gemini 2.5 Flash (LangChain)         → chart vision, marketing planning, content tools
  - Gemini 2.5 Flash (LiteLLM/CrewAI)   → marketing CrewAI agents

Data:
  - PostgreSQL  → banking churn warehouse
  - Tavily      → web research (banking + marketing)
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from same directory as this file (always wins over parent env)
_env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=str(_env_path), override=True)

# ── API Keys ─────────────────────────────────────────────────────────────────
GOOGLE_API_KEY    = os.getenv("GOOGLE_API_KEY", "")
TAVILY_API_KEY    = os.getenv("TAVILY_API_KEY", "")
NVIDIA_API_KEY    = os.getenv("NVIDIA_API_KEY", "")
LANGCHAIN_API_KEY = os.getenv("LANGCHAIN_API_KEY", "")
ZEP_API_KEY       = os.getenv("ZEP_API_KEY", "")
EXA_API_KEY       = os.getenv("EXA_API_KEY", "")
CEREBRAS_API_KEY  = os.getenv("CEREBRAS_API_KEY", "")

# ── LangSmith Tracing ────────────────────────────────────────────────────────
if LANGCHAIN_API_KEY:
    os.environ["LANGCHAIN_TRACING_V2"] = "true"
    os.environ["LANGCHAIN_API_KEY"]    = LANGCHAIN_API_KEY
    os.environ["LANGCHAIN_PROJECT"]    = "Bank_Analytics_Digital_Marketing"

if TAVILY_API_KEY:
    os.environ["TAVILY_API_KEY"] = TAVILY_API_KEY

# ── Former Cerebras settings (no longer used for LLM calls) ───────
# Cerebras exposes an OpenAI-compatible endpoint, so CrewAI/LiteLLM agents can
# also target it. Set OPENAI_API_KEY so LiteLLM's openai/* provider authenticates.
CEREBRAS_MODEL    = os.getenv("CEREBRAS_MODEL", "gpt-oss-120b")
CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"

if CEREBRAS_API_KEY:
    os.environ.setdefault("CEREBRAS_API_KEY", CEREBRAS_API_KEY)
    # LiteLLM (CrewAI) resolves openai/* models using OPENAI_API_KEY even when
    # api_key is passed explicitly to LLM(); point it at the Cerebras endpoint.
    os.environ["OPENAI_API_KEY"]  = CEREBRAS_API_KEY
    os.environ["OPENAI_BASE_URL"] = CEREBRAS_BASE_URL

# Kept for backward-compat with config imports elsewhere.
NVIDIA_MODEL = CEREBRAS_MODEL

# ── Claude Haiku 5.5 (Anthropic) — every text LLM call goes through here ──────
# Cerebras returned 402 Payment Required, so all text generation moved to
# Anthropic. Marketing poster/image generation still uses Gemini (see below).
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL   = os.getenv("ANTHROPIC_MODEL", "claude-haiku-5-5")
# Model string for CrewAI's LiteLLM-backed LLM(...).
CREWAI_MODEL      = f"anthropic/{ANTHROPIC_MODEL}"
# Marketing poster images (Gemini). Off by default to keep runs cheap; set
# ENABLE_POSTER_GENERATION=true in .env to bring the poster step back.
ENABLE_POSTER_GENERATION = os.getenv("ENABLE_POSTER_GENERATION", "false").strip().lower() in ("1", "true", "yes")
# Model the data with dbt before the analytics crew runs (PostgreSQL only, ~10–20k tokens).
DBT_MODELING = os.getenv("DBT_MODELING", "true").strip().lower() in ("1", "true", "yes")
# Design an interactive dashboard automatically after each analysis run (~4k tokens).
AUTO_DASHBOARD = os.getenv("AUTO_DASHBOARD", "true").strip().lower() in ("1", "true", "yes")
# Haiku 5.5 thinks by default and thinking tokens count toward max_tokens, which
# left short-budget calls (e.g. NL->SQL at 400 tokens) with no text at all.
# Every call here is a bounded task, so thinking is off (also cheaper).
CLAUDE_THINKING   = {"type": "disabled"}

try:
    from anthropic import Anthropic as _Anthropic
    anthropic_client = _Anthropic(api_key=ANTHROPIC_API_KEY, max_retries=2, timeout=180) if ANTHROPIC_API_KEY else None
except Exception:
    anthropic_client = None


def make_crew_llm(max_tokens: int = 8192, timeout: int = 300):
    """CrewAI LLM for Claude Haiku 5.5 (CrewAI's native Anthropic provider).

    Two fixes over a plain ``LLM(model="anthropic/...")``:
    - When an agent hits max_iter, CrewAI leaves the conversation ending on an
      assistant turn; Haiku 5.5 rejects that as prefill ("The conversation must
      end with a user message"), crashing the crew. A user turn is appended.
    - Tool arguments (e.g. a whole report in ``content``) are generated inside the
      reply, so a low max_tokens truncates the tool call and required arguments go
      missing. Callers should keep max_tokens generous; only used tokens are billed.
    """
    from crewai.llms.providers.anthropic.completion import AnthropicCompletion

    class _ClaudeCrewLLM(AnthropicCompletion):
        def _format_messages_for_anthropic(self, messages):
            formatted, system = super()._format_messages_for_anthropic(messages)
            if formatted and formatted[-1].get("role") == "assistant":
                formatted.append({"role": "user", "content": "Continue, and give your final answer now."})
            return formatted, system

    return _ClaudeCrewLLM(
        model=ANTHROPIC_MODEL,
        api_key=ANTHROPIC_API_KEY,
        max_tokens=max_tokens,
        timeout=timeout,
        max_retries=2,
        thinking=CLAUDE_THINKING,
    )


class LLMUnavailableError(RuntimeError):
    """Raised when the LLM could not produce a reply (all retries failed or timed out).

    Callers must not substitute an error string for model output, or it ends up
    being treated as a real plan/report downstream.
    """


def query_claude(messages: list, temperature: float = 0, max_tokens: int = 8192) -> str:
    """Call Claude Haiku 5.5 with OpenAI-style ``[{"role", "content"}]`` messages.

    System messages are lifted into Anthropic's ``system`` parameter; consecutive
    same-role messages are merged because the Messages API requires alternation.
    """
    if anthropic_client is None:
        raise RuntimeError("ANTHROPIC_API_KEY is not set (or the anthropic package is missing)")

    system_parts, turns = [], []
    for m in messages:
        role, content = m.get("role"), m.get("content") or ""
        if role == "system":
            system_parts.append(content)
            continue
        role = "assistant" if role == "assistant" else "user"
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"] += "\n\n" + content
        else:
            turns.append({"role": role, "content": content})
    if not turns or turns[0]["role"] != "user":
        turns.insert(0, {"role": "user", "content": "Continue."})

    # ``temperature`` is accepted for caller compatibility but not sent: Haiku 5.5
    # rejects it ("temperature is deprecated for this model").
    kwargs = dict(model=ANTHROPIC_MODEL, messages=turns, max_tokens=max_tokens, thinking=CLAUDE_THINKING)
    if system_parts:
        kwargs["system"] = "\n\n".join(system_parts)
    resp = anthropic_client.messages.create(**kwargs)
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


def query_cerebras(messages: list, temperature: float = 0, max_tokens: int = 8192, **_) -> str:
    """Backward-compat shim — routes to Claude Haiku 5.5."""
    return query_claude(messages, temperature=temperature, max_tokens=max_tokens)


def query_ollama(messages: list, temperature: float = 0, max_tokens: int = 1024) -> str:
    """Backward-compat shim — routes to Claude Haiku 5.5."""
    return query_claude(messages, temperature=temperature, max_tokens=max_tokens)


def query_nvidia(messages: list, temperature: float = 0, max_tokens: int = 8192) -> str:
    """Backward-compat shim — routes to Claude Haiku 5.5."""
    return query_claude(messages, temperature=temperature, max_tokens=max_tokens)


def get_langchain_llm(temperature: float = 0.1, max_tokens: int = 4096):
    """LangChain chat model backed by Claude Haiku 5.5.

    Supports ``.invoke([HumanMessage(...)])`` the same way the previous
    Cerebras/Ollama chat models did.
    """
    from langchain_anthropic import ChatAnthropic
    return ChatAnthropic(
        model=ANTHROPIC_MODEL,
        api_key=ANTHROPIC_API_KEY,
        max_tokens=max_tokens,  # temperature is not sent; see query_claude
        thinking=CLAUDE_THINKING,
        timeout=180,
        max_retries=2,
    )


# ── Gemini 2.5 Flash (LangChain – used in tool helpers & graph nodes) ────────
GEMINI_MODEL = "gemini-2.5-flash"

try:
    from langchain_google_genai import ChatGoogleGenerativeAI
    gemini_llm = ChatGoogleGenerativeAI(
        model=GEMINI_MODEL,
        temperature=0.1,
        google_api_key=GOOGLE_API_KEY,
        timeout=30,
        max_retries=3,
    ) if GOOGLE_API_KEY else None
except Exception:
    gemini_llm = None

# ── PostgreSQL Data Warehouse ────────────────────────────────────────────────
POSTGRES_CONFIG = {
    "host":     os.getenv("POSTGRES_HOST",     "localhost"),
    "port":     os.getenv("POSTGRES_PORT",     "5432"),
    "database": os.getenv("POSTGRES_DB",       "churn"),
    "user":     os.getenv("POSTGRES_USER",     "postgres"),
    "password": os.getenv("POSTGRES_PASSWORD", ""),
}

POSTGRES_URI = (
    f"postgresql://{POSTGRES_CONFIG['user']}:{POSTGRES_CONFIG['password']}"
    f"@{POSTGRES_CONFIG['host']}:{POSTGRES_CONFIG['port']}/{POSTGRES_CONFIG['database']}"
)

# ── Output directories ───────────────────────────────────────────────────────
_BASE = Path(__file__).parent
for _d in ("outputs/charts", "outputs/reports", "outputs/models",
           "outputs/videos", "outputs/content", "outputs/audit"):
    (_BASE / _d).mkdir(parents=True, exist_ok=True)

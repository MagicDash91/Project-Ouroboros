"""
tools/visual_explain.py – a Conclusion and an Actionable insight for every visual in a report.

Used by the Studio (features/studio.py: documents, decks and their Word / PDF / PowerPoint exports)
and by the report generators (tools/bank_report.py: the Analytics / Agent / Workflow PDF and PPT).

    explain(items, context) -> {id: {"conclusion": str, "action": str}}

items: [{"id", "kind": "chart"|"table"|"image", "title", "data": text the numbers come from, "chart": optional}]
One Claude call for all visuals (forced tool use). Numbers may only come from the item's data or the
report text; the data is fenced as untrusted. Without Claude (no key, outage, budget stop) a
deterministic fallback still fills both fields, so no visual is ever left unexplained.
"""

import json
import os
import re
from typing import Optional

MAX_ITEMS = 40

_TOOL = {
    "name": "explain_visuals",
    "description": "For each visual, its conclusion and one actionable insight.",
    "input_schema": {"type": "object", "properties": {"items": {"type": "array", "items": {
        "type": "object", "properties": {
            "id": {"type": "string"},
            "conclusion": {"type": "string", "description": "1-2 sentences: what the visual proves (the 'so what'), "
                                                            "with the key number(s) from its data."},
            "action": {"type": "string", "description": "One concrete, verb-first recommendation that follows from it "
                                                        "(what to do, where, and the expected effect)."}},
        "required": ["id", "conclusion", "action"]}}}, "required": ["items"]},
}


def _num(v) -> Optional[float]:
    try:
        f = float(str(v).replace(",", "").replace("%", "").strip())
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def chart_text(chart: dict, limit: int = 30) -> str:
    """A chart's data as text for the model: label → value per series."""
    labels = chart.get("labels") or []
    lines = []
    for s in (chart.get("series") or [])[:6]:
        pairs = [f"{l}: {v}" for l, v in zip(labels[:limit], s.get("values") or []) if v is not None]
        lines.append(f"{s.get('name') or 'value'} ({chart.get('unit') or 'no unit'}) — " + "; ".join(pairs))
    return f"{chart.get('type', 'bar')} chart. " + " | ".join(lines)


def table_text(table: dict, limit: int = 15) -> str:
    cols = table.get("columns") or []
    rows = table.get("rows") or []
    return " | ".join(str(c) for c in cols) + "\n" + "\n".join(" | ".join(str(c) for c in r) for r in rows[:limit])


def _fmt(v: float) -> str:
    a = abs(v)
    return f"{v / 1e9:,.2f} bn" if a >= 1e9 else f"{v / 1e6:,.2f} M" if a >= 1e6 else f"{v:,.0f}" if a >= 100 else f"{v:,.2f}"


def fallback(item: dict) -> dict:
    """Deterministic explanation when Claude is unavailable."""
    title = item.get("title") or "this visual"
    chart = item.get("chart")
    if chart and chart.get("labels") and chart.get("series"):
        s = chart["series"][0]
        pairs = [(l, _num(v)) for l, v in zip(chart["labels"], s.get("values") or []) if _num(v) is not None]
        if len(pairs) >= 2:
            unit = f" {chart.get('unit')}" if chart.get("unit") else ""
            top, low = max(pairs, key=lambda p: p[1]), min(pairs, key=lambda p: p[1])
            if chart.get("type") in ("line", "area"):
                first, last = pairs[0], pairs[-1]
                change = (last[1] - first[1]) / abs(first[1]) * 100 if first[1] else 0
                return {"conclusion": f"{title}: from {first[0]} to {last[0]} the value moved {change:+.0f}% "
                                      f"({_fmt(first[1])}{unit} → {_fmt(last[1])}{unit}); the peak was {top[0]} "
                                      f"at {_fmt(top[1])}{unit}.",
                        "action": f"Find out what drove the {top[0]} peak and repeat it in the weaker periods, "
                                  f"starting with {low[0]}."}
            total = sum(p[1] for p in pairs)
            share = f" ({top[1] / total * 100:.0f}% of the total)" if total > 0 else ""
            return {"conclusion": f"{top[0]} leads with {_fmt(top[1])}{unit}{share}; {low[0]} is lowest at "
                                  f"{_fmt(low[1])}{unit}.",
                    "action": f"Protect and grow {top[0]}, and review what holds back {low[0]} before reallocating "
                              f"budget."}
    note = re.sub(r"\s+", " ", str(item.get("data") or "")).strip()
    note = re.sub(r"^[#>*\-\s]+", "", note)
    first = re.split(r"(?<=[.!?])\s", note)[0][:240] if note else ""
    return {"conclusion": first or f"{title} summarises a key result of this report.",
            "action": "Discuss this result with the owners of the area it covers and agree one concrete next step."}


def explain(items: list, context: str = "") -> dict:
    """{id: {conclusion, action}} for every item (Claude, else the fallback)."""
    items = [i for i in items if i.get("id")][:MAX_ITEMS]
    if not items:
        return {}
    out: dict = {}
    try:
        from config import ANTHROPIC_MODEL, CLAUDE_THINKING, anthropic_client
        from tools.llm_security import FENCE_RULE, clean_output, fence
        if anthropic_client is None:
            raise RuntimeError("no Claude client")
        listing = "\n\n".join(
            f"id: {i['id']}\nkind: {i.get('kind', 'chart')}\ntitle: {i.get('title', '')}\ndata:\n"
            + str(i.get("data") or (chart_text(i["chart"]) if i.get("chart") else ""))[:2500]
            for i in items)
        resp = anthropic_client.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=min(8000, 400 + 260 * len(items)), thinking=CLAUDE_THINKING,
            system=("You are a senior business analyst. For every visual in a report write a Conclusion (what it "
                    "proves, with its key numbers) and one Actionable insight (a concrete, verb-first recommendation "
                    "with where/who and the expected effect). Use ONLY numbers that appear in the visual's data or "
                    "the report text; never invent figures. Write in the report's language. " + FENCE_RULE),
            tools=[_TOOL], tool_choice={"type": "tool", "name": "explain_visuals"},
            messages=[{"role": "user", "content": "Report text (context):\n" + fence(context[:20000], "report")
                       + "\n\nVisuals:\n" + fence(listing, "visuals")}])
        block = next((b for b in resp.content if getattr(b, "type", "") == "tool_use"), None)
        for r in ((block.input or {}).get("items") if block else None) or []:
            if isinstance(r, dict) and r.get("id") and r.get("conclusion") and r.get("action"):
                out[str(r["id"])] = {"conclusion": clean_output(r["conclusion"])[:600],
                                     "action": clean_output(r["action"])[:600]}
    except Exception:
        pass
    for i in items:
        out.setdefault(str(i["id"]), fallback(i))
    return out


def session_chart_meta(path_or_url: str) -> dict:
    """Title / analysis / recommendation the chart engine recorded for a chart PNG (outputs/charts)."""
    name = os.path.basename(str(path_or_url)).split("?")[0]
    side = os.path.splitext(str(path_or_url).split("?")[0])[0] + ".meta.json"   # written by the Agent
    if os.path.isfile(side):
        try:
            with open(side, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    meta_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "outputs", "charts",
                             "session_charts.json")
    try:
        with open(meta_path, encoding="utf-8") as fh:
            for m in reversed(json.load(fh)):
                if os.path.basename(str(m.get("chart_url", ""))).split("?")[0] == name:
                    return m
    except Exception:
        pass
    return {}

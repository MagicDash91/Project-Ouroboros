"""
zep_graph.py – Zep Cloud + Exa AI knowledge graph integration.

Builds a BUSINESS INTELLIGENCE graph: real entities (brand, competitors,
segments, problems, campaigns) and their relationships.
gpt-oss:120b-cloud extracts entities from the analytics report.
Exa AI enriches competitors and industry trends with live web intelligence.
"""
from __future__ import annotations

import os
import re
import json
from pathlib import Path
from datetime import datetime

BASE_DIR  = Path(__file__).parent
GRAPH_DIR = BASE_DIR / "outputs" / "graph"
GRAPH_DIR.mkdir(parents=True, exist_ok=True)


def _safe_id(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_]", "_", str(s)).lower().strip("_")[:48]


def _extract(pattern: str, text: str, default: str = "") -> str:
    m = re.search(pattern, text or "", re.IGNORECASE)
    return m.group(1).strip() if m else default


def _extract_all(pattern: str, text: str) -> list[str]:
    return re.findall(pattern, text or "", re.IGNORECASE)


def _zep_client():
    try:
        from zep_cloud.client import Zep
        key = os.environ.get("ZEP_API_KEY", "")
        if not key:
            from config import ZEP_API_KEY
            key = ZEP_API_KEY
        return Zep(api_key=key) if key else None
    except Exception:
        return None


def _exa_client():
    try:
        from exa_py import Exa
        key = os.environ.get("EXA_API_KEY", "")
        if not key:
            from config import EXA_API_KEY
            key = EXA_API_KEY
        return Exa(api_key=key) if key else None
    except Exception:
        return None


def _exa_search(exa, query: str, num_results: int = 3) -> list[dict]:
    """Run Exa search, return list of {title, url, snippet} dicts."""
    try:
        res = exa.search(
            query,
            type="auto",
            num_results=num_results,
            contents={"highlights": True},
        )
        out = []
        for r in res.results:
            highlights = getattr(r, "highlights", None) or []
            snippet = highlights[0] if highlights else ""
            out.append({
                "title":   getattr(r, "title", "") or "",
                "url":     getattr(r, "url",   "") or "",
                "snippet": snippet[:200] if snippet else "",
            })
        return out
    except Exception as exc:
        print(f"[ZepGraph] Exa search failed: {exc}", flush=True)
        return []


def _discover_competitors(exa, brand_name: str, industry: str) -> list[str]:
    """
    Auto-discover competitors via three Exa angles + gpt-oss name extraction.
    Returns up to 5 names including unseen / emerging players.
    """
    print(f"[ZepGraph] Discovering competitors for {brand_name} in {industry}…", flush=True)
    all_snippets: list[str] = []
    for query in [
        f"{brand_name} main competitors alternatives {industry}",
        f"companies competing with {brand_name} {industry} 2025",
        f"{industry} market share top players ranking 2025",
    ]:
        for hit in _exa_search(exa, query, num_results=3):
            s = hit["snippet"] or hit["title"]
            if s:
                all_snippets.append(s)

    combined = " ".join(all_snippets)[:3500]
    if not combined.strip():
        return []
    try:
        prompt = (
            f"From the following web research, extract the names of companies that directly "
            f"compete with {brand_name} in the {industry} market.\n\n"
            f"Research:\n{combined}\n\n"
            f"Include well-known players AND smaller/emerging competitors. "
            f"Return ONLY a JSON array of strings (company names). "
            f"Do NOT include '{brand_name}'. Max 5 names.\n"
            f'Example: ["CompanyA", "CompanyB"]'
        )
        raw = _ollama(prompt, timeout=60)
        m = re.search(r"\[[\s\S]*?\]", raw)
        if m:
            names = json.loads(m.group(0))
            return [
                n.strip() for n in names
                if isinstance(n, str) and brand_name.lower() not in n.lower()
            ][:5]
    except Exception as exc:
        print(f"[ZepGraph] Competitor discovery failed: {exc}", flush=True)
    return []


def _classify_sentiment(text: str, entity_name: str, brand_name: str) -> str:
    """
    gpt-oss classifies how an entity relates to the brand.
    Returns: threatening | negative | warning | neutral | positive
    """
    if not text.strip():
        return "neutral"
    try:
        prompt = (
            f"Classify the sentiment of this intelligence about '{entity_name}' "
            f"relative to the brand '{brand_name}'.\n\n"
            f"Text:\n{text[:500]}\n\n"
            "Reply with ONLY one word:\n"
            "  threatening — entity is actively winning our customers or capturing our market share\n"
            "  negative    — represents a risk, loss, or unfavorable condition\n"
            "  warning     — early signal that needs monitoring before it worsens\n"
            "  neutral     — informational with no clear positive or negative valence\n"
            "  positive    — favorable for the brand, opportunity or strength"
        )
        raw = _ollama(prompt, timeout=35).strip().lower().split()[0]
        return raw if raw in {"threatening", "negative", "warning", "neutral", "positive"} else "neutral"
    except Exception:
        return "neutral"


def _ollama(prompt: str, system: str = "", timeout: int = 120) -> str:
    """Call Claude Haiku 5.5 with timeout."""
    import concurrent.futures
    from config import get_langchain_llm
    from langchain_core.messages import HumanMessage, SystemMessage

    def _call():
        msgs = []
        if system:
            msgs.append(SystemMessage(content=system))
        msgs.append(HumanMessage(content=prompt))
        llm  = get_langchain_llm()
        resp = llm.invoke(msgs)
        return resp.content.strip() if hasattr(resp, "content") else str(resp).strip()

    ex  = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    fut = ex.submit(_call)
    try:
        result = fut.result(timeout=timeout)
        ex.shutdown(wait=False)
        return result
    except Exception as exc:
        ex.shutdown(wait=False)
        raise exc


def _extract_business_entities(full_text: str, industry: str, brand_name: str) -> dict:
    """
    Use gpt-oss:120b-cloud to read the analytics report and extract universal
    business entities — works for churn, fraud, credit risk, sales, or any case.

    Returns dict with predictive fields for future-state forecasting:
        problem, metric, trajectory, urgency,
        risk_factors[], segments[], causal_links[],
        leading_indicators[], intervention_opportunities[],
        predicted_outcome, external_forces[], key_insight
    """
    prompt = (
        f"You are a business intelligence analyst reading an analytics report for {brand_name} "
        f"in the {industry} industry.\n\n"
        f"Report excerpt (first 2500 chars):\n{full_text[:2500]}\n\n"
        "Extract the following as JSON (respond with ONLY valid JSON, no markdown, no code block):\n"
        "{\n"
        '  "problem": "<primary business problem: Customer Churn, Fraud Risk, Credit Default, Sales Decline, etc.>",\n'
        '  "metric": "<key metric with value if found, e.g. 26% churn rate, $2M fraud loss>",\n'
        '  "trajectory": "<worsening | stable | improving — direction of the metric trend>",\n'
        '  "urgency": "<critical | high | moderate | low>",\n'
        '  "risk_factors": [\n'
        '    {"name": "<short factor name>", "desc": "<one sentence>", "strength": "<high|medium|low>"},\n'
        "    ... up to 5 items ordered by impact\n"
        "  ],\n"
        '  "segments": [\n'
        '    {"name": "<segment name>", "desc": "<one sentence on who they are and business priority>", "risk_level": "<high|medium|low>"},\n'
        "    ... up to 4 items\n"
        "  ],\n"
        '  "causal_links": [\n'
        '    {"segment": "<segment name from above>", "risk_factor": "<risk factor name from above>", "relationship": "<2-3 word edge label, e.g. driven by, amplified by>"},\n'
        "    ... up to 4 items — specific segment-to-risk-factor causal pairs\n"
        "  ],\n"
        '  "leading_indicators": [\n'
        '    {"name": "<indicator name>", "desc": "<why this is an early warning signal — what it predicts>"},\n'
        "    ... up to 3 items — observable signals that predict the problem BEFORE it worsens\n"
        "  ],\n"
        '  "intervention_opportunities": [\n'
        '    {"name": "<action name>", "desc": "<specific action and expected impact>", "targets": "<which risk factor or segment this addresses>"},\n'
        "    ... up to 3 items — concrete actions that can improve the trajectory\n"
        "  ],\n"
        '  "predicted_outcome": "<one sentence: what happens to the key metric in 3-6 months if NO action is taken>",\n'
        '  "external_forces": [\n'
        '    {"name": "<external force name>", "desc": "<how this market/regulatory/tech force amplifies the problem>"},\n'
        "    ... up to 3 items\n"
        "  ],\n"
        '  "key_insight": "<single most important insight from the report for executive decision-making>"\n'
        "}"
    )
    try:
        raw = _ollama(prompt, timeout=100)
        m = re.search(r"\{[\s\S]*\}", raw)
        if m:
            return json.loads(m.group(0))
    except Exception as exc:
        print(f"[ZepGraph] Entity extraction failed: {exc}", flush=True)

    # Fallback defaults
    return {
        "problem":      "Business Problem",
        "metric":       "",
        "trajectory":   "worsening",
        "urgency":      "high",
        "risk_factors": [
            {"name": "Key Risk Factor 1", "desc": "Primary risk identified in the report.", "strength": "high"},
            {"name": "Key Risk Factor 2", "desc": "Secondary risk identified in the report.", "strength": "medium"},
        ],
        "segments": [
            {"name": "High Value",  "desc": "Most profitable segment. Priority: retain.", "risk_level": "medium"},
            {"name": "At-Risk",     "desc": "Most vulnerable segment. Priority: intervene.", "risk_level": "high"},
            {"name": "Loyal",       "desc": "Stable segment. Priority: cross-sell.", "risk_level": "low"},
            {"name": "Dormant",     "desc": "Low engagement. Priority: re-activate.", "risk_level": "high"},
        ],
        "causal_links": [],
        "leading_indicators": [
            {"name": "Declining Engagement", "desc": "Drop in usage frequency signals impending exit."},
            {"name": "Support Escalations",  "desc": "Increase in complaints precedes problem escalation."},
        ],
        "intervention_opportunities": [
            {"name": "Proactive Outreach",   "desc": "Engage at-risk segment before they act.", "targets": "At-Risk"},
            {"name": "Loyalty Incentive",    "desc": "Reward loyalty to reduce vulnerability.",  "targets": "Dormant"},
        ],
        "predicted_outcome": "Without intervention, the problem metric is expected to worsen within 3-6 months.",
        "external_forces": [
            {"name": "Digital Disruption", "desc": "Competitors using technology to target vulnerable segments."},
        ],
        "key_insight": "Analysis complete — see full report for details.",
    }


def _generate_graph_analysis(nodes: dict, edges: list) -> str:
    """Use gpt-oss to write a forward-looking executive narrative for decision-making."""
    try:
        def _labels(grp):
            return ", ".join(
                n["label"].replace("\n", " ")
                for n in nodes.values() if n["group"] == grp
            ) or "none"

        def _title(node_id):
            n = nodes.get(node_id)
            return n["title"] if n else ""

        forecast_node = next((n for n in nodes.values() if n["group"] == "forecast"), None)
        forecast_detail = (forecast_node["title"] if forecast_node else "No forecast modeled.")

        graph_summary = (
            f"Brand: {_labels('brand')}\n"
            f"Business Problem: {_labels('problem')}\n"
            f"Problem Trajectory & Forecast: {forecast_detail}\n"
            f"Risk Factors: {_labels('risk_factor')}\n"
            f"Early Warning Signals: {_labels('signal')}\n"
            f"Customer/Market Segments: {_labels('segment')}\n"
            f"External Market Forces: {_labels('market_force')}\n"
            f"Competitors: {_labels('competitor')}\n"
            f"Intervention Opportunities: {_labels('opportunity')}\n"
            f"Marketing Campaign: {_labels('campaign')}\n"
            f"Channels: {_labels('channel')}\n"
            f"Web Intelligence (Exa): {_labels('exa_insight')}\n"
            f"Total graph connections: {len(edges)}"
        )

        prompt = (
            "You are a senior business strategist. Based on the knowledge graph below, "
            "write a concise 320-370 word executive analysis optimized for DECISION-MAKING AND PREDICTION.\n\n"
            "Write as flowing paragraphs (no bullet points, no headers):\n"
            "1. What the primary business problem is, its current trajectory, and the predicted outcome "
            "   if no action is taken (reference the forecast node data).\n"
            "2. The causal chain: which risk factors and external forces are driving the problem, "
            "   and which customer/market segments are most exposed.\n"
            "3. Early warning signals that leadership must monitor NOW as leading indicators of worsening.\n"
            "4. The intervention strategy: how the campaign and opportunity nodes address root causes, "
            "   and which competitor moves create the most competitive pressure.\n"
            "5. Two or three specific, time-sensitive executive actions prioritized by impact.\n\n"
            f"Knowledge Graph:\n{graph_summary}\n\n"
            "Be specific, confident, forward-looking, and board-ready. "
            "Distinguish clearly between current state and predicted future state."
        )
        return _ollama(prompt, timeout=130)
    except Exception as exc:
        print(f"[ZepGraph] LLM analysis skipped: {exc}", flush=True)
        return ""


class KnowledgeGraphBuilder:
    def __init__(self, task_id: str):
        self.task_id = task_id
        self.user_id = f"ua_{_safe_id(task_id[:12])}"
        self.nodes: dict[str, dict] = {}
        self.edges: list[dict]      = []
        self._zep      = _zep_client()
        self._exa      = _exa_client()
        self._analysis = ""
        self._init_zep_user()

    # ── Zep ──────────────────────────────────────────────────────────────────

    def _init_zep_user(self):
        if not self._zep:
            return
        try:
            self._zep.user.add(
                user_id    = self.user_id,
                first_name = "Analytics",
                last_name  = "Agent",
                email      = f"{self.user_id}@universalai.local",
            )
        except Exception:
            pass

    def push_to_zep(self, text: str):
        if not self._zep or not text.strip():
            return
        try:
            self._zep.graph.add(user_id=self.user_id, type="text", data=text)
        except Exception as exc:
            print(f"[ZepGraph] push skipped: {exc}", flush=True)

    # ── Graph helpers ─────────────────────────────────────────────────────────

    def add_node(self, node_id: str, label: str, group: str,
                 title: str = "", sentiment: str = "neutral"):
        self.nodes[node_id] = {
            "id":        node_id,
            "label":     label,
            "group":     group,
            "title":     title or label,
            "sentiment": sentiment,
        }

    def _update_sentiment(self, node_id: str, sentiment: str):
        if node_id in self.nodes:
            self.nodes[node_id]["sentiment"] = sentiment

    def add_edge(self, from_id: str, to_id: str, label: str):
        if from_id in self.nodes and to_id in self.nodes:
            self.edges.append({"from": from_id, "to": to_id, "label": label})

    # ── Analytics layer ───────────────────────────────────────────────────────

    def build_analytics(
        self,
        industry: str,
        brand_name: str,
        tables: list[str],
        chart_titles: list[str],
        banking_report: str,
        scientist_output: str,
    ):
        full_text = (banking_report or "") + "\n" + (scientist_output or "")

        # ── gpt-oss entity extraction ─────────────────────────────────────────
        print("[ZepGraph] Extracting business entities via gpt-oss…", flush=True)
        ents = _extract_business_entities(full_text, industry, brand_name)
        problem_name = ents.get("problem", "Business Problem")
        metric       = ents.get("metric", "")
        risk_factors = ents.get("risk_factors", [])
        segments     = ents.get("segments",     [])
        key_insight  = ents.get("key_insight",  "")

        # ── 1. BRAND (central node) ───────────────────────────────────────────
        brand_id = "brand"
        self.add_node(brand_id, brand_name[:22], "brand",
                      f"Brand: {brand_name}\nIndustry: {industry}\n"
                      f"Primary challenge: {problem_name}",
                      sentiment="neutral")

        # ── 2. BUSINESS PROBLEM ───────────────────────────────────────────────
        problem_id    = "business_problem"
        problem_label = f"{metric}\n{problem_name}" if metric else problem_name
        self.add_node(problem_id, problem_label[:28], "problem",
                      f"Business problem: {problem_name}\n"
                      f"{('Metric: ' + metric) if metric else ''}\n"
                      f"{key_insight}",
                      sentiment="negative")
        self.add_edge(brand_id, problem_id, "experiencing")

        # ── 3. RISK FACTORS (from gpt-oss) ───────────────────────────────────
        for i, rf in enumerate(risk_factors[:5]):
            rf_id  = _safe_id(f"risk_{i}")
            rf_snt = "negative" if rf.get("strength", "medium") == "high" else "warning"
            self.add_node(rf_id, rf["name"][:22], "risk_factor",
                          f"{rf['name']}\nStrength: {rf.get('strength','medium')}\n\n{rf['desc']}",
                          sentiment=rf_snt)
            self.add_edge(rf_id, problem_id, "drives")

        # ── 4. CUSTOMER/MARKET SEGMENTS (from gpt-oss) ───────────────────────
        _seg_snt = {"high": "negative", "medium": "warning", "low": "positive"}
        for i, seg in enumerate(segments[:4]):
            s_id    = f"segment_{i}"
            rl      = seg.get("risk_level", "medium")
            seg_snt = _seg_snt.get(rl, "warning")
            self.add_node(s_id, seg["name"][:20], "segment",
                          f"{seg['name']}\nRisk level: {rl}\n\n{seg['desc']}",
                          sentiment=seg_snt)
            self.add_edge(brand_id, s_id, "serves")
            if rl == "high":
                self.add_edge(s_id, problem_id, "most exposed to")

        # ── 5. CAUSAL LINKS: segment → specific risk factor ──────────────────
        causal_links = ents.get("causal_links", [])
        for cl in causal_links[:4]:
            seg_name = (cl.get("segment") or "").lower()
            rf_name  = (cl.get("risk_factor") or "").lower()
            rel      = cl.get("relationship", "driven by")
            seg_id = next(
                (f"segment_{i}" for i, s in enumerate(segments[:4])
                 if s["name"].lower() == seg_name), None)
            rf_id = next(
                (_safe_id(f"risk_{i}") for i, rf in enumerate(risk_factors[:5])
                 if rf["name"].lower() == rf_name), None)
            if seg_id and rf_id:
                self.add_edge(seg_id, rf_id, rel)

        # ── 6. LEADING INDICATORS (signal nodes) ─────────────────────────────
        leading_indicators = ents.get("leading_indicators", [])
        for i, li in enumerate(leading_indicators[:3]):
            li_id = _safe_id(f"signal_{i}")
            self.add_node(li_id, li["name"][:22], "signal",
                          f"Early warning signal\n{li['name']}\n\n{li['desc']}",
                          sentiment="warning")
            self.add_edge(li_id, problem_id, "signals")

        # ── 7. EXTERNAL FORCES (market_force nodes) ───────────────────────────
        external_forces = ents.get("external_forces", [])
        for i, ef in enumerate(external_forces[:3]):
            mf_id = _safe_id(f"force_{i}")
            self.add_node(mf_id, ef["name"][:22], "market_force",
                          f"External market force\n{ef['name']}\n\n{ef['desc']}",
                          sentiment="negative")
            self.add_edge(mf_id, problem_id, "amplifies")

        # ── 8. PREDICTED OUTCOME (forecast node) ──────────────────────────────
        predicted_outcome = ents.get("predicted_outcome", "")
        trajectory = ents.get("trajectory", "worsening")
        urgency    = ents.get("urgency",    "high")
        if predicted_outcome:
            _fc_snt = {"improving": "positive", "stable": "warning"}.get(trajectory, "negative")
            forecast_label = f"{trajectory.title()} Trajectory"
            self.add_node("forecast", forecast_label, "forecast",
                          f"Predicted outcome (no action taken):\n{predicted_outcome}\n\n"
                          f"Urgency: {urgency}\nTrajectory: {trajectory}",
                          sentiment=_fc_snt)
            self.add_edge(problem_id, "forecast", "leads to")

        # ── 9. INTERVENTION OPPORTUNITIES (opportunity nodes) ─────────────────
        intervention_opportunities = ents.get("intervention_opportunities", [])
        for i, op in enumerate(intervention_opportunities[:3]):
            op_id = _safe_id(f"oppty_{i}")
            self.add_node(op_id, op["name"][:22], "opportunity",
                          f"Intervention opportunity\n{op['name']}\n\n"
                          f"{op['desc']}\nTargets: {op.get('targets', '')}",
                          sentiment="positive")
            if "forecast" in self.nodes:
                self.add_edge(op_id, "forecast", "prevents")
            targets = op.get("targets", "").lower()
            for j, rf in enumerate(risk_factors[:5]):
                if any(w in targets for w in rf["name"].lower().split()):
                    self.add_edge(op_id, _safe_id(f"risk_{j}"), "addresses")
                    break

        # ── Push business narrative to Zep ────────────────────────────────────
        rf_names = ", ".join(rf["name"] for rf in risk_factors[:5]) or "not specified"
        sg_names = ", ".join(s["name"]  for s  in segments[:4])     or "not specified"
        li_names = ", ".join(li["name"] for li in leading_indicators[:3]) or "not identified"
        ef_names = ", ".join(ef["name"] for ef in external_forces[:3])    or "none identified"
        self.push_to_zep(
            f"{brand_name} operates in the {industry} industry. "
            f"Primary business problem: {problem_name}{('. Metric: ' + metric) if metric else ''}. "
            f"Trajectory: {trajectory}. Urgency: {urgency}. "
            f"Key risk factors: {rf_names}. "
            f"Customer/market segments: {sg_names}. "
            f"Early warning signals: {li_names}. "
            f"External market forces: {ef_names}. "
            f"Predicted outcome if no action: {predicted_outcome} "
            f"Key insight: {key_insight}"
        )
        self.save()

    # ── Marketing layer ───────────────────────────────────────────────────────

    def add_marketing(
        self,
        campaign_type: str,
        target_audience: str,
        budget: str,
        competitors: str,
        marketing_report: str,
    ):
        # ── CAMPAIGN ─────────────────────────────────────────────────────────
        camp_id = "campaign"
        self.add_node(camp_id, campaign_type[:22], "campaign",
                      f"Campaign: {campaign_type}\n"
                      f"Target: {target_audience}\nBudget: {budget}",
                      sentiment="positive")
        if "brand" in self.nodes:
            self.add_edge("brand", camp_id, "launching")
        if "business_problem" in self.nodes:
            self.add_edge(camp_id, "business_problem", "addresses")

        # Campaign targets all high-risk segments
        for i in range(4):
            seg_id = f"segment_{i}"
            if seg_id in self.nodes and "high" in self.nodes[seg_id].get("title", "").lower():
                self.add_edge(camp_id, seg_id, "targets")

        # Campaign executes the intervention opportunities from analytics
        for i in range(3):
            op_id = _safe_id(f"oppty_{i}")
            if op_id in self.nodes:
                self.add_edge(camp_id, op_id, "executes")

        # ── AUTO-DISCOVER COMPETITORS via Exa + gpt-oss ───────────────────────
        brand_name = self.nodes.get("brand", {}).get("label", "")
        industry_label = self.nodes.get("brand", {}).get("title", "")
        _m = re.search(r"Industry:\s*(.+)", industry_label)
        industry_ctx = _m.group(1).strip() if _m else "business"

        _manual = [c.strip() for c in (competitors or "").split(",")
                   if c.strip() and c.strip().lower() != "not specified"]
        if _manual:
            comp_list = _manual[:5]
            print(f"[ZepGraph] Using provided competitors: {comp_list}", flush=True)
        elif self._exa:
            comp_list = _discover_competitors(self._exa, brand_name, industry_ctx)
        else:
            comp_list = []

        for ci, comp in enumerate(comp_list):
            comp_id = _safe_id(f"comp_{comp}")
            # Start with threatening; update after Exa classification
            self.add_node(comp_id, comp, "competitor",
                          f"Competitor: {comp}\nAnalyzed for threat level and strategy.",
                          sentiment="threatening")
            if "brand" in self.nodes:
                self.add_edge("brand", comp_id, "competes with")
            for seg_id in ("segment_1", "segment_0"):
                if seg_id in self.nodes:
                    self.add_edge(comp_id, seg_id, "targeting")
                    break
            if "forecast" in self.nodes:
                self.add_edge(comp_id, "forecast", "accelerates")

            if self._exa:
                all_comp_snippets: list[str] = []

                # Search 1: strategy & retention
                print(f"[ZepGraph] Exa → competitor strategy: {comp}", flush=True)
                for hi, hit in enumerate(_exa_search(
                    self._exa,
                    f"{comp} marketing strategy customer retention loyalty program",
                    num_results=2,
                )):
                    snippet = hit["snippet"] or hit["title"]
                    if not snippet:
                        continue
                    all_comp_snippets.append(snippet)
                    self.push_to_zep(f"Competitive intelligence — {comp} strategy: {snippet}")
                    ei_id = _safe_id(f"exa_{comp}_s{hi}")
                    self.add_node(ei_id, (hit["title"] or snippet)[:24], "exa_insight",
                                  f"Competitor strategy — {comp}\nSource: {hit['url'] or 'web'}\n\n{snippet}",
                                  sentiment="neutral")
                    self.add_edge(comp_id, ei_id, "strategy insight")

                # Search 2: recent moves
                print(f"[ZepGraph] Exa → competitor news: {comp}", flush=True)
                for hi, hit in enumerate(_exa_search(
                    self._exa,
                    f"{comp} new offer product launch customer switching 2025",
                    num_results=2,
                )):
                    snippet = hit["snippet"] or hit["title"]
                    if not snippet:
                        continue
                    all_comp_snippets.append(snippet)
                    self.push_to_zep(f"Recent competitor move — {comp}: {snippet}")
                    ni_id = _safe_id(f"exa_{comp}_n{hi}")
                    self.add_node(ni_id, f"News: {(hit['title'] or snippet)[:20]}", "exa_insight",
                                  f"Recent move — {comp}\nSource: {hit['url'] or 'web'}\n\n{snippet}",
                                  sentiment="neutral")
                    self.add_edge(comp_id, ni_id, "recent move")

                # Classify competitor sentiment from all collected snippets
                if all_comp_snippets:
                    print(f"[ZepGraph] Classifying sentiment for {comp}…", flush=True)
                    comp_sentiment = _classify_sentiment(
                        " ".join(all_comp_snippets)[:800], comp, brand_name
                    )
                    self._update_sentiment(comp_id, comp_sentiment)
                    # exa_insight nodes inherit competitor sentiment
                    for ni in (f"exa_{comp}_s0", f"exa_{comp}_s1",
                               f"exa_{comp}_n0", f"exa_{comp}_n1"):
                        nid = _safe_id(ni)
                        self._update_sentiment(nid, comp_sentiment)

        # ── CHANNELS ─────────────────────────────────────────────────────────
        channels_found = []
        ch_patterns = [
            (r"social\s*media|instagram|tiktok|facebook",  "Social Media"),
            (r"email\s*marketing|email\s*campaign",         "Email"),
            (r"google\s*ads|search\s*ads|sem|ppc",          "Search Ads"),
            (r"display|banner\s*ad",                        "Display Ads"),
            (r"content\s*marketing|blog|article",           "Content"),
            (r"push\s*notification|mobile\s*app|sms",       "Mobile Push"),
        ]
        for pat, ch_name in ch_patterns:
            if re.search(pat, marketing_report or "", re.IGNORECASE):
                channels_found.append(ch_name)
        if not channels_found:
            channels_found = ["Social Media", "Email", "Search Ads"]

        for ch in channels_found[:4]:
            ch_id = _safe_id(f"ch_{ch}")
            self.add_node(ch_id, ch, "channel",
                          f"Marketing channel: {ch}\nDeployed for: {campaign_type} campaign.",
                          sentiment="neutral")
            self.add_edge(camp_id, ch_id, "delivered via")

        # ── INDUSTRY INTELLIGENCE (Exa) — trends + disruption ─────────────────
        if self._exa:
            _force_kws = ("regulation", "law", "policy", "gdpr", "compliance",
                          "economy", "recession", "inflation", "technology",
                          "ai ", "artificial intelligence", "digital transform")

            # Search 1: market trends & customer behavior
            print(f"[ZepGraph] Exa → market trends: {industry_ctx}", flush=True)
            for ti, hit in enumerate(_exa_search(
                self._exa,
                f"{industry_ctx} market trends customer behavior 2025 2026",
                num_results=3,
            )):
                snippet = hit["snippet"] or hit["title"]
                if not snippet:
                    continue
                self.push_to_zep(f"Market trend — {industry_ctx}: {snippet}")
                is_force = any(kw in snippet.lower() for kw in _force_kws)
                t_id = _safe_id(f"exa_trend_{ti}")
                node_type = "market_force" if is_force else "exa_insight"
                t_snt = "negative" if is_force else "neutral"
                self.add_node(t_id, (hit["title"] or snippet)[:24], node_type,
                              f"{'Market force' if is_force else 'Industry trend'}\n"
                              f"Source: {hit['url'] or 'web'}\n\n{snippet}",
                              sentiment=t_snt)
                self.add_edge(t_id, camp_id, "informs")
                if is_force and "forecast" in self.nodes:
                    self.add_edge(t_id, "forecast", "shapes")

            # Search 2: regulatory / tech disruption
            print(f"[ZepGraph] Exa → disruption forecast: {industry_ctx}", flush=True)
            for di, hit in enumerate(_exa_search(
                self._exa,
                f"{industry_ctx} regulation technology disruption 2025 forecast",
                num_results=2,
            )):
                snippet = hit["snippet"] or hit["title"]
                if not snippet:
                    continue
                self.push_to_zep(f"Regulatory/tech disruption — {industry_ctx}: {snippet}")
                d_id = _safe_id(f"exa_disrupt_{di}")
                self.add_node(d_id, (hit["title"] or snippet)[:24], "market_force",
                              f"Structural disruption\nSource: {hit['url'] or 'web'}\n\n{snippet}",
                              sentiment="negative")
                if "business_problem" in self.nodes:
                    self.add_edge(d_id, "business_problem", "accelerates")
                if "forecast" in self.nodes:
                    self.add_edge(d_id, "forecast", "shapes")

        # ── Zep narrative ─────────────────────────────────────────────────────
        brand_label   = self.nodes.get("brand", {}).get("label", "The brand")
        problem_label = self.nodes.get("business_problem", {}).get("label", "business problem").replace("\n", " ")
        self.push_to_zep(
            f"{brand_label} is launching a {campaign_type} campaign targeting {target_audience}. "
            f"Budget: {budget}. Competitors discovered: {', '.join(comp_list) or 'none'}. "
            f"Channels: {', '.join(channels_found)}. "
            f"Campaign addresses {problem_label} by targeting vulnerable segments and countering competitor moves."
        )

        # ── LLM graph analysis ────────────────────────────────────────────────
        print("[ZepGraph] Generating LLM graph analysis…", flush=True)
        self._analysis = _generate_graph_analysis(self.nodes, self.edges)
        self.save()

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self) -> Path:
        data = {
            "task_id":    self.task_id,
            "updated_at": datetime.now().isoformat(),
            "nodes":      list(self.nodes.values()),
            "edges":      self.edges,
            "analysis":   self._analysis,
        }
        path = GRAPH_DIR / f"graph_{self.task_id[:8]}.json"
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        return path


# ── Public API ────────────────────────────────────────────────────────────────

def get_graph_data(task_id: str) -> dict:
    """Return nodes + edges for vis.js, enriched with Zep-extracted entities."""
    path = GRAPH_DIR / f"graph_{task_id[:8]}.json"
    if not path.exists():
        return {"nodes": [], "edges": [], "analysis": ""}

    data = json.loads(path.read_text(encoding="utf-8"))

    # Enrich with Zep's extracted knowledge graph entities
    zep = _zep_client()
    if zep:
        try:
            user_id = f"ua_{_safe_id(task_id[:12])}"
            results = zep.graph.search(
                user_id=user_id,
                query="business problem risk factors market segments insights",
                limit=12,
            )
            existing_ids  = {n["id"] for n in data["nodes"]}
            existing_edges = {(e["from"], e["to"]) for e in data["edges"]}

            if hasattr(results, "edges") and results.edges:
                for ze in results.edges[:10]:
                    fact     = getattr(ze, "fact",             "") or ""
                    src_name = getattr(ze, "source_node_name", "") or ""
                    tgt_name = getattr(ze, "target_node_name", "") or ""
                    relation = getattr(ze, "relation_type",    "") or "related to"

                    if not fact and not (src_name and tgt_name):
                        continue

                    # Add source node
                    src_id = _safe_id(f"z_{src_name[:20]}") if src_name else None
                    if src_id and src_id not in existing_ids:
                        short = src_name[:24] + ("…" if len(src_name) > 24 else "")
                        data["nodes"].append({
                            "id":    src_id,
                            "label": short,
                            "group": "zep_entity",
                            "title": f"Zep entity: {src_name}\n{fact}",
                        })
                        existing_ids.add(src_id)

                    # Add target node
                    tgt_id = _safe_id(f"z_{tgt_name[:20]}") if tgt_name else None
                    if tgt_id and tgt_id not in existing_ids:
                        short = tgt_name[:24] + ("…" if len(tgt_name) > 24 else "")
                        data["nodes"].append({
                            "id":    tgt_id,
                            "label": short,
                            "group": "zep_entity",
                            "title": f"Zep entity: {tgt_name}\n{fact}",
                        })
                        existing_ids.add(tgt_id)

                    # Add edge between them
                    if src_id and tgt_id and (src_id, tgt_id) not in existing_edges:
                        rel_label = relation.lower().replace("_", " ")[:20]
                        data["edges"].append({
                            "from":  src_id,
                            "to":    tgt_id,
                            "label": rel_label,
                        })
                        existing_edges.add((src_id, tgt_id))

                    # If no src/tgt but has fact, add as standalone insight node
                    elif fact and not src_name:
                        fid = _safe_id(f"zfact_{fact[:18]}")
                        if fid not in existing_ids:
                            data["nodes"].append({
                                "id":    fid,
                                "label": fact[:28] + ("…" if len(fact) > 28 else ""),
                                "group": "zep_entity",
                                "title": f"Zep insight:\n{fact}",
                            })
                            existing_ids.add(fid)
        except Exception:
            pass

    return data

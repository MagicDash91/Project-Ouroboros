"""
features/kits.py – ready-made industry kits: sample data, metric definitions, questions, a workflow and
report starters, so a new user sees value in minutes in their own industry.

Every company here is FICTIONAL and every dataset is generated deterministically (fixed seed) on first
use into data/samples/<kit>/, with patterns worth finding:

  fnb        Kopi Nusantara        coffee chain (features/samples.py): Ramadan, 11.11 / 12.12, online shift
  retail     Pasar Raya Mart       10-store minimarket chain, 2024-2025: Lebaran rush, payday weeks, QRIS
                                   adoption, a competitor hitting Bekasi Timur, a Bandung fresh-produce
                                   stock problem, a new Malang store
  banking    BPR Sejahtera Makmur  rural bank loan book, West Java, 2023-2025: a Garut dry season pushing
                                   NPL up from Q3 2025, consumer loans souring after Lebaran
  marketing  Batik Lestari         online batik brand, 2025 ad performance: TikTok getting cheaper, Meta
                                   costs spiking at Harbolnas, Google Search fatigue in September, a
                                   Hari Batik (2 Oct) influencer burst, Lebaran outfit demand

A kit's metric definitions and questions travel with the Data chat session it opens (session-scoped,
so they never change the user's own glossary).
"""

import random
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "data" / "samples"


class KitError(ValueError):
    pass


def _pick(rng, pairs):
    r, acc = rng.random() * sum(w for _, w in pairs), 0.0
    for v, w in pairs:
        acc += w
        if r <= acc:
            return v
    return pairs[-1][0]


def _days(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


# ── Retail: Pasar Raya Mart ───────────────────────────────────────────────────

STORES = [  # id, name, city, format, opened
    ("S01", "Kemang", "Jakarta", "Supermarket", date(2019, 5, 1)),
    ("S02", "Kelapa Gading", "Jakarta", "Supermarket", date(2018, 2, 1)),
    ("S03", "Bekasi Timur", "Bekasi", "Minimarket", date(2020, 8, 1)),
    ("S04", "Margonda", "Depok", "Minimarket", date(2021, 3, 1)),
    ("S05", "Bogor Baru", "Bogor", "Minimarket", date(2020, 1, 1)),
    ("S06", "Dago", "Bandung", "Supermarket", date(2019, 9, 1)),
    ("S07", "Antapani", "Bandung", "Minimarket", date(2022, 4, 1)),
    ("S08", "Tunjungan", "Surabaya", "Supermarket", date(2018, 11, 1)),
    ("S09", "Rungkut", "Surabaya", "Minimarket", date(2021, 6, 1)),
    ("S10", "Malang Kota", "Malang", "Minimarket", date(2025, 3, 1)),
]
CATEGORIES = [  # name, share of sales, cost ratio, avg item price (IDR)
    ("Groceries", 0.31, 0.86, 18500), ("Fresh produce", 0.14, 0.78, 14000),
    ("Snacks & beverages", 0.22, 0.76, 9500), ("Personal care", 0.13, 0.72, 27000),
    ("Household", 0.12, 0.75, 31000), ("Baby & kids", 0.08, 0.80, 42000),
]
LEBARAN = {2024: date(2024, 4, 10), 2025: date(2025, 3, 31)}


def _retail(folder: Path):
    rng = random.Random(41)
    size = {"Supermarket": 1.0, "Minimarket": 0.42}
    store_rows = [{"store_id": i, "store": n, "city": c, "store_format": f, "opened_date": o.isoformat()}
                  for i, n, c, f, o in STORES]
    rows = []
    for day in _days(date(2024, 1, 1), date(2025, 12, 31)):
        t = (day - date(2024, 1, 1)).days / 730
        to_leb = (LEBARAN[day.year] - day).days
        payday = day.day >= 25 or day.day <= 2
        for sid, name, city, fmt, opened in STORES:
            if day < opened:
                continue
            base = 42_000_000 * size[fmt] * (1 + 0.12 * t)
            base *= 1.15 if day.weekday() >= 5 and fmt == "Supermarket" else 1.06 if day.weekday() >= 5 else 1.0
            base *= 1.12 if payday else 1.0
            base *= 1.10 if day.month == 12 and day.day >= 15 else 1.0
            if sid == "S10":                                              # new store ramping up
                base *= min(1.0, 0.45 + 0.55 * (day - opened).days / 150)
            if sid == "S03" and day >= date(2025, 6, 1):                   # a competitor opened nearby
                base *= 0.78
            qris = min(0.62, 0.18 + 0.28 * t + rng.uniform(-0.03, 0.03)) * (1.15 if city == "Jakarta" else 1.0)
            card = 0.17 if fmt == "Supermarket" else 0.09
            for cat, share, cost_ratio, price in CATEGORIES:
                v = base * share
                if 1 <= to_leb <= 14 and cat in ("Groceries", "Snacks & beverages", "Personal care", "Baby & kids"):
                    v *= 1.45 + (0.25 if cat == "Snacks & beverages" else 0)  # Lebaran shopping rush
                elif -2 <= to_leb <= 0:
                    v *= 0.38                                             # Lebaran day and the days after
                if sid == "S07" and cat == "Fresh produce" and date(2025, 8, 4) <= day <= date(2025, 9, 28):
                    v *= 0.58                                             # supplier problem: empty shelves
                gross = max(0.0, v * rng.gauss(1, 0.08))
                discounts = gross * (0.07 if 1 <= to_leb <= 14 else 0.03) * rng.uniform(0.7, 1.3)
                returns = gross * rng.uniform(0.002, 0.01)
                net = gross - discounts - returns
                q_share = min(0.9, qris * rng.uniform(0.9, 1.1))
                items = max(1, round(gross / price))
                rows.append({"date": day.isoformat(), "store_id": sid, "store": name, "city": city, "store_format": fmt,
                             "category": cat, "transactions": max(1, round(items / rng.uniform(2.2, 3.1))),
                             "items_sold": items, "gross_sales": round(gross), "discounts": round(discounts),
                             "returns": round(returns), "net_sales": round(net), "cogs": round(gross * cost_ratio),
                             "gross_margin": round(net - gross * cost_ratio), "qris_sales": round(net * q_share),
                             "card_sales": round(net * card), "cash_sales": round(net * max(0.0, 1 - q_share - card))})
    pd.DataFrame(rows).to_csv(folder / "store_sales.csv", index=False)
    pd.DataFrame(store_rows).to_csv(folder / "stores.csv", index=False)


# ── Banking: BPR Sejahtera Makmur ─────────────────────────────────────────────

BRANCHES = [("Bandung", 0.24), ("Garut", 0.19), ("Tasikmalaya", 0.17), ("Cianjur", 0.14), ("Sukabumi", 0.13),
            ("Cirebon", 0.13)]
PRODUCTS_BANK = [  # product, share, avg amount (IDR), tenor months, rate % p.a.
    ("KUR Mikro", 0.38, 35_000_000, 24, 6.0), ("Modal Kerja UMKM", 0.24, 120_000_000, 36, 12.5),
    ("Kredit Konsumtif", 0.26, 25_000_000, 18, 16.0), ("Kredit Pensiunan", 0.12, 60_000_000, 60, 11.0),
]
SECTORS = {"KUR Mikro": [("Agriculture", 0.45), ("Trade", 0.35), ("Services", 0.12), ("Manufacturing", 0.08)],
           "Modal Kerja UMKM": [("Trade", 0.42), ("Manufacturing", 0.24), ("Services", 0.22), ("Agriculture", 0.12)],
           "Kredit Konsumtif": [("Household", 1.0)], "Kredit Pensiunan": [("Household", 1.0)]}
FIRST = ["Asep", "Dedi", "Ujang", "Siti", "Neng", "Euis", "Agus", "Yanti", "Rina", "Dadang", "Iwan", "Lilis",
         "Cecep", "Nur", "Tati", "Hendra", "Wawan", "Yuyun", "Rudi", "Imas"]
LAST = ["Sunarya", "Hidayat", "Rahmawati", "Permana", "Kurniawan", "Suryani", "Setiawan", "Nurhayati", "Gunawan",
        "Saputra", "Maulana", "Lestari", "Firmansyah", "Rosita"]


def _kol(dpd: int) -> int:
    return 1 if dpd == 0 else 2 if dpd <= 90 else 3 if dpd <= 120 else 4 if dpd <= 180 else 5


def _stress(branch: str, product: str, sector: str, month: date) -> float:
    """Extra monthly default pressure: the Garut dry season (farmers and the traders who depend on them)
    and post-Lebaran consumer strain."""
    s = 1.0
    if branch == "Garut" and sector in ("Agriculture", "Trade") and date(2025, 5, 1) <= month <= date(2025, 11, 1):
        s *= 10.0
    if product == "Kredit Konsumtif" and date(2025, 5, 1) <= month <= date(2025, 9, 1):
        s *= 2.2
    return s


def _banking(folder: Path):
    rng = random.Random(77)
    months = [date(y, m, 1) for y in (2023, 2024, 2025) for m in range(1, 13)]
    loans = []
    for i in range(1, 6501):
        disb = date(2023, 1, 1) + timedelta(days=int(rng.random() ** 0.85 * 1090))
        branch = _pick(rng, BRANCHES)
        product, _, avg, tenor, rate = _pick(rng, [(p, p[1]) for p in PRODUCTS_BANK])
        sector = _pick(rng, SECTORS[product])
        if product == "KUR Mikro" and rng.random() < 0.6:
            collateral = "None"
        elif product == "Kredit Pensiunan":
            collateral = "Pension decree (SK)"
        else:
            collateral = rng.choice(["Land certificate (SHM)", "Vehicle (BPKB)"])
        loans.append({"loan_id": f"L{i:05d}", "debtor_name": f"{rng.choice(FIRST)} {rng.choice(LAST)}",
                      "branch": branch, "product": product, "sector": sector, "disbursed_date": disb.isoformat(),
                      "amount_idr": int(round(avg * rng.lognormvariate(0, 0.45), -5)), "tenor_months": tenor,
                      "interest_rate_pct": round(rate + rng.uniform(-1, 1.5), 2), "collateral": collateral,
                      "loan_officer": f"AO-{rng.randint(1, 12):02d}", "_dpd": 0, "_closed": None, "_wo": False})

    snap = []
    for m in months:
        nxt = (m.replace(day=28) + timedelta(days=4)).replace(day=1)
        agg = {}
        for ln in loans:
            disb = date.fromisoformat(ln["disbursed_date"])
            if disb >= nxt or ln["_closed"]:
                continue
            a = agg.setdefault((ln["branch"], ln["product"]), {
                "accounts": 0, "outstanding_idr": 0.0, "npl_outstanding_idr": 0.0, "kol2_outstanding_idr": 0.0,
                "new_loans": 0, "new_disbursement_idr": 0.0})
            if disb >= m:
                a["new_loans"] += 1
                a["new_disbursement_idr"] += ln["amount_idr"]
            age = (m.year - disb.year) * 12 + m.month - disb.month
            if age >= ln["tenor_months"] and ln["_dpd"] == 0:
                ln["_closed"] = m                                   # paid off
                continue
            if ln["_dpd"] == 0:                                      # delinquency moves once a month
                if disb < m and rng.random() < 0.011 * _stress(ln["branch"], ln["product"], ln["sector"], m):
                    ln["_dpd"] = rng.randint(5, 30)
            elif rng.random() < (0.16 if ln["_dpd"] < 90 else 0.03):
                ln["_dpd"] = 0                                      # cured
            else:
                ln["_dpd"] += 30
            if ln["_dpd"] > 360:
                ln["_closed"], ln["_wo"] = m, True                  # written off
                continue
            bal = ln["amount_idr"] * (0.15 + 0.85 * max(0.0, 1 - age / ln["tenor_months"]))
            a["accounts"] += 1
            a["outstanding_idr"] += bal
            k = _kol(ln["_dpd"])
            if k >= 3:
                a["npl_outstanding_idr"] += bal
            elif k == 2:
                a["kol2_outstanding_idr"] += bal
        for (b, p), a in agg.items():
            snap.append({"month": m.isoformat(), "branch": b, "product": p,
                         **{k: (round(v) if isinstance(v, float) else v) for k, v in a.items()}})

    out = []
    for ln in loans:
        status = "Written off" if ln["_wo"] else "Paid off" if ln["_closed"] else "Active"
        dpd = ln["_dpd"] if status == "Active" else 0
        out.append({**{k: v for k, v in ln.items() if not k.startswith("_")}, "status": status,
                    "days_past_due": dpd, "collectibility": _kol(dpd) if status == "Active" else None,
                    "as_of": "2025-12-31"})
    pd.DataFrame(out).to_csv(folder / "loans.csv", index=False)
    pd.DataFrame(snap).to_csv(folder / "portfolio_monthly.csv", index=False)


# ── Marketing: Batik Lestari ──────────────────────────────────────────────────

CAMPAIGNS = [  # channel, campaign, start, end, daily spend (IDR), cpm, ctr, cvr, aov
    ("Meta Ads", "Always-on prospecting", date(2025, 1, 1), date(2025, 12, 31), 2_400_000, 38_000, 0.011, 0.018, 410_000),
    ("Meta Ads", "Retargeting", date(2025, 1, 1), date(2025, 12, 31), 900_000, 52_000, 0.019, 0.042, 430_000),
    ("Google Search", "Brand keywords", date(2025, 1, 1), date(2025, 12, 31), 500_000, 90_000, 0.085, 0.061, 455_000),
    ("Google Search", "Generic: batik pria / wanita", date(2025, 1, 1), date(2025, 12, 31), 1_500_000, 70_000, 0.042, 0.026, 395_000),
    ("TikTok Ads", "Spark Ads: creators", date(2025, 4, 1), date(2025, 12, 31), 1_200_000, 21_000, 0.009, 0.014, 360_000),
    ("TikTok Ads", "Live shopping boost", date(2025, 6, 1), date(2025, 12, 31), 700_000, 18_000, 0.012, 0.019, 340_000),
    ("Email", "Newsletter & flows", date(2025, 1, 1), date(2025, 12, 31), 300_000, 25_000, 0.032, 0.035, 470_000),
    ("Influencer", "Lebaran outfit collab", date(2025, 3, 3), date(2025, 3, 28), 3_500_000, 30_000, 0.016, 0.022, 520_000),
    ("Influencer", "Hari Batik Nasional", date(2025, 9, 27), date(2025, 10, 5), 6_000_000, 26_000, 0.021, 0.027, 480_000),
]


def _marketing(folder: Path):
    rng = random.Random(1002)
    rows = []
    for ch, name, start, end, spend, cpm, ctr, cvr, aov in CAMPAIGNS:
        for day in _days(start, end):
            s, c_cpm, c_ctr, c_cvr = spend, cpm, ctr, cvr
            demand = 1.0
            if date(2025, 3, 1) <= day <= date(2025, 3, 29):
                demand = 1.6                                           # Lebaran outfits
            if date(2025, 9, 27) <= day <= date(2025, 10, 4):
                demand = max(demand, 1.45)                             # Hari Batik, 2 October
            demand *= 1.12 if day.weekday() >= 5 else 1.0
            demand *= 1.1 if day.day >= 25 or day.day <= 2 else 1.0
            if ch == "TikTok Ads":                                     # gets cheaper as creatives improve
                months_in = (day - start).days / 30
                c_cvr *= 1 + 0.07 * months_in
                s *= 1 + 0.05 * months_in
            if ch == "Meta Ads" and ((day.month == 11 and day.day >= 5) or (day.month == 12 and day.day <= 15)):
                c_cpm *= 1.55                                          # Harbolnas auction pressure
            if name.startswith("Generic") and day >= date(2025, 9, 1):
                c_ctr *= 0.66                                          # ad fatigue, a competitor outbids
                c_cvr *= 0.85
            if ch == "Email":
                c_ctr *= 1 + 0.25 * (day - start).days / 365            # list grows
            s *= rng.uniform(0.85, 1.15)
            impressions = int(s / c_cpm * 1000)
            clicks = int(impressions * c_ctr * demand * rng.uniform(0.85, 1.15))
            orders = int(clicks * c_cvr * rng.uniform(0.8, 1.2) * (1.1 if demand > 1.3 else 1))
            returning = ch == "Email" or name == "Brand keywords"
            rows.append({"date": day.isoformat(), "channel": ch, "campaign": name, "spend_idr": round(s),
                         "impressions": impressions, "clicks": clicks,
                         "add_to_carts": int(orders * rng.uniform(2.6, 3.4)), "orders": orders,
                         "revenue_idr": round(orders * aov * rng.uniform(0.9, 1.1)),
                         "new_customers": int(orders * (0.35 if returning else 0.7) * rng.uniform(0.85, 1.15))})
    pd.DataFrame(rows).sort_values(["date", "channel", "campaign"]).to_csv(folder / "campaign_daily.csv", index=False)


# ── Workflows ─────────────────────────────────────────────────────────────────

def _node(i, t, label, cfg, x, y):
    return {"id": i, "type": t, "label": label, "position": {"x": x, "y": y}, "config": cfg}


def _edges(*pairs):
    """(source, target) or (source, target, "left" | "right") for join inputs."""
    return [{"source": p[0], "target": p[1], **({"targetHandle": p[2]} if len(p) > 2 else {})} for p in pairs]


def _wf_fnb():
    nodes = [
        _node("src", "upload", "Sample sales", {"file": "sales_2025.csv"}, 0, 120),
        _node("qc", "quality_check", "Check the data", {"rules": "not_null: order_id, revenue\nnot_null: region\n"
                                                                 "between: rating, 1, 5", "on_fail": "continue"}, 260, 120),
        _node("month", "date_tools", "Month", {"column": "order_date", "operation": "month"}, 520, 120),
        _node("agg", "aggregate", "Revenue by month & channel", {"group_by": ["order_date_month", "channel"],
                                                                 "column": "revenue", "function": "sum"}, 780, 120),
        _node("growth", "calculate", "Month-on-month growth", {"operation": "pct_change", "column": "revenue",
                                                               "order_by": "order_date_month", "group_by": ["channel"],
                                                               "new_column": "growth_pct"}, 1040, 40),
        _node("chart", "chart", "Revenue by channel", {"kind": "line", "x": "order_date_month", "y": "revenue",
                                                       "color": "channel", "title": "Monthly revenue by channel, 2025"},
              1040, 220),
        _node("fc", "forecast", "Next 3 months", {"date_column": "order_date", "value_column": "revenue",
                                                  "frequency": "M", "periods": 3}, 520, 300),
        _node("table", "pivot", "Channels x months", {"rows": ["channel"], "columns": "order_date_month",
                                                      "values": "revenue", "function": "sum"}, 1300, 40),
        _node("ai", "ai_insights", "What changed?", {"mode": "insights"}, 1560, 40),
        _node("export", "export", "Excel", {"format": "xlsx", "filename": "kopi_nusantara_monthly"}, 1300, 220),
    ]
    edges = _edges(("src", "qc"), ("qc", "month"), ("month", "agg"), ("agg", "growth"), ("agg", "chart"),
                   ("agg", "table"), ("table", "ai"), ("growth", "export"), ("qc", "fc"))
    return ("Kopi Nusantara · monthly channel check (sample)", nodes, edges, "sales_2025.csv",
            "Sample workflow: checks the data, sums revenue per month and channel, computes growth, forecasts the "
            "next 3 months, asks the AI what changed and exports to Excel. Press Run.")


def _wf_retail():
    nodes = [
        _node("src", "upload", "Store sales", {"file": "store_sales.csv"}, 0, 140),
        _node("qc", "quality_check", "Check the data", {"rules": "not_null: date, store_id, net_sales\n"
                                                                 "between: net_sales, 0, 100000000\nmin_rows: 1000",
                                                        "on_fail": "continue"}, 260, 140),
        _node("month", "date_tools", "Month", {"column": "date", "operation": "month", "new_column": "month"}, 520, 60),
        _node("agg", "aggregate", "Net sales by month & store", {"group_by": ["month", "store"], "column": "net_sales",
                                                                 "function": "sum"}, 780, 60),
        _node("chart", "chart", "Net sales by store", {"kind": "line", "x": "month", "y": "net_sales", "color": "store",
                                                       "title": "Monthly net sales by store"}, 1040, 0),
        _node("growth", "calculate", "Month-on-month growth", {"operation": "pct_change", "column": "net_sales",
                                                               "order_by": "month", "group_by": ["store"],
                                                               "new_column": "growth_pct"}, 1040, 140),
        _node("fc", "forecast", "Next 3 months", {"date_column": "date", "value_column": "net_sales",
                                                  "frequency": "M", "periods": 3}, 520, 260),
        _node("table", "pivot", "Stores x months", {"rows": ["store"], "columns": "month", "values": "net_sales",
                                                    "function": "sum"}, 1300, 140),
        _node("ai", "ai_insights", "Store review", {"mode": "custom", "instructions":
              "Each row is a store, each column a month of net sales (IDR). Which stores are growing or shrinking, "
              "and what should the area manager check first?"}, 1560, 140),
        _node("export", "export", "Excel", {"format": "xlsx", "filename": "pasar_raya_monthly_by_store"}, 1300, 0),
    ]
    edges = _edges(("src", "qc"), ("qc", "month"), ("month", "agg"), ("agg", "chart"), ("agg", "growth"),
                   ("agg", "table"), ("table", "ai"), ("growth", "export"), ("qc", "fc"))
    return ("Pasar Raya Mart · monthly store review (sample)", nodes, edges, "store_sales.csv",
            "Sample workflow: checks the data, sums net sales per month and store, computes growth, forecasts the "
            "next 3 months and asks the AI which stores need attention. Press Run.")


def _wf_banking():
    nodes = [
        _node("src", "upload", "Portfolio (monthly)", {"file": "portfolio_monthly.csv"}, 0, 140),
        _node("qc", "quality_check", "Check the data", {"rules": "not_null: month, branch, outstanding_idr\n"
                                                                 "min_rows: 100", "on_fail": "continue"}, 260, 140),
        _node("ratio", "formula", "NPL ratio %", {"new_column": "npl_ratio_pct",
                                                  "expression": "npl_outstanding_idr / outstanding_idr * 100"}, 520, 140),
        _node("recent", "filter", "2025 only", {"column": "month", "operator": ">=", "value": "2025-01-01"}, 780, 140),
        _node("agg", "aggregate", "NPL outstanding by month & branch", {"group_by": ["month", "branch"],
                                                                        "column": "npl_outstanding_idr",
                                                                        "function": "sum"}, 1040, 60),
        _node("chart", "chart", "NPL by branch", {"kind": "line", "x": "month", "y": "npl_outstanding_idr",
                                                  "color": "branch", "title": "NPL outstanding (Kol 3-5) by branch, 2025"},
              1300, 0),
        _node("table", "pivot", "Branches x months", {"rows": ["branch"], "columns": "month",
                                                      "values": "npl_outstanding_idr", "function": "sum"}, 1300, 140),
        _node("ai", "ai_insights", "Risk review", {"mode": "custom", "instructions":
              "Each row is a branch, each column a month-end NPL balance (IDR, collectibility 3-5) in 2025. Which "
              "branches drive the NPL trend, and what should the credit committee do this month?"}, 1560, 140),
        _node("export", "export", "Excel", {"format": "xlsx", "filename": "bpr_npl_by_branch"}, 1300, 280),
    ]
    edges = _edges(("src", "qc"), ("qc", "ratio"), ("ratio", "recent"), ("recent", "agg"), ("agg", "chart"),
                   ("agg", "table"), ("table", "ai"), ("ratio", "export"))
    return ("BPR Sejahtera Makmur · monthly NPL review (sample)", nodes, edges, "portfolio_monthly.csv",
            "Sample workflow: checks the portfolio file, adds the NPL ratio, keeps 2025, charts NPL by branch and asks "
            "the AI what the credit committee should look at. Press Run.")


def _wf_marketing():
    nodes = [
        _node("src", "upload", "Campaign results", {"file": "campaign_daily.csv"}, 0, 140),
        _node("qc", "quality_check", "Check the data", {"rules": "not_null: date, channel, spend_idr\n"
                                                                 "between: spend_idr, 0, 50000000", "on_fail": "continue"},
              260, 140),
        _node("week", "date_tools", "Week", {"column": "date", "operation": "week_start", "new_column": "week"}, 520, 140),
        _node("agg", "aggregate", "Revenue by week & channel", {"group_by": ["week", "channel"], "column": "revenue_idr",
                                                                "function": "sum"}, 780, 60),
        _node("chart", "chart", "Revenue by channel", {"kind": "line", "x": "week", "y": "revenue_idr", "color": "channel",
                                                       "title": "Weekly revenue by channel"}, 1040, 0),
        _node("spend", "aggregate", "Spend by channel", {"group_by": ["channel"], "column": "spend_idr",
                                                         "function": "sum"}, 780, 220),
        _node("rev", "aggregate", "Revenue by channel", {"group_by": ["channel"], "column": "revenue_idr",
                                                         "function": "sum"}, 780, 320),
        _node("join", "join", "Spend + revenue", {"left_on": "channel", "right_on": "channel", "how": "inner"}, 1040, 260),
        _node("roas", "formula", "ROAS", {"new_column": "roas", "expression": "revenue_idr / spend_idr"}, 1300, 260),
        _node("anom", "anomaly", "Unusual days", {"column": "revenue_idr", "date_column": "date",
                                                  "method": "rolling_zscore", "sensitivity": 3, "window": 14}, 520, 420),
        _node("ai", "ai_insights", "Budget advice", {"mode": "custom", "instructions":
              "One row per channel with 2025 spend, revenue and ROAS (revenue / spend). Where should next month's "
              "budget move, and what should be tested first?"}, 1560, 260),
        _node("export", "export", "Excel", {"format": "xlsx", "filename": "batik_lestari_weekly"}, 1040, 60),
    ]
    edges = _edges(("src", "qc"), ("qc", "week"), ("week", "agg"), ("agg", "chart"), ("qc", "spend"), ("qc", "rev"),
                   ("spend", "join", "left"), ("rev", "join", "right"), ("join", "roas"), ("roas", "ai"),
                   ("agg", "export"), ("qc", "anom"))
    return ("Batik Lestari · weekly channel performance (sample)", nodes, edges, "campaign_daily.csv",
            "Sample workflow: checks the ad data, sums revenue per week and channel, computes ROAS per channel, flags "
            "unusual days and asks the AI where to move budget. Press Run.")


def _kopi_generate(folder: Path):
    from features import samples
    samples.files()                                       # features/samples.py writes into this same folder


# ── Kits ──────────────────────────────────────────────────────────────────────

KITS = {
    "fnb": {
        "name": "Kopi Nusantara", "industry": "Food & beverage", "folder": "kopi_nusantara",
        "files": ["sales_2025.csv", "customers.csv", "campaigns.csv"], "chat_files": ["sales_2025.csv", "campaigns.csv"],
        "agent_files": ["sales_2025.csv", "campaigns.csv"], "generate": _kopi_generate, "workflow": _wf_fnb,
        "tagline": "Coffee & snacks chain · 8 cities · 5 channels · 2025",
        "description": "A fictional Indonesian coffee & snacks chain: 2025 orders across 8 cities and 5 channels, "
                       "customers and marketing campaigns.",
        "highlights": ["Ramadan moves sales from stores to GoFood", "11.11 and 12.12 marketplace spikes",
                       "online grows from 35% to 58% of revenue"],
        "metrics": [
            {"term": "Revenue", "definition": "sum of revenue (after discount), in IDR"},
            {"term": "Gross profit", "definition": "revenue - cost (column gross_profit)"},
            {"term": "Gross margin %", "definition": "gross_profit / revenue x 100"},
            {"term": "Orders", "definition": "number of distinct order_id (a row is one product line of an order)"},
            {"term": "Average order value (AOV)", "definition": "revenue / number of distinct order_id"},
            {"term": "Online share", "definition": "revenue from Website, GoFood, Shopee and Tokopedia / total revenue"},
            {"term": "Campaign ROI", "definition": "(attributed_revenue_idr - budget_idr) / budget_idr"},
        ],
        "questions": [
            "Why did revenue change in March 2025 (Ramadan) compared with February?",
            "Forecast monthly revenue for the next 3 months, with a likely range.",
            "What if we raise prices 5% and lose 4% of orders? Show next quarter's revenue against the forecast.",
            "Which channels and cities have the best gross margin %?",
            "Which marketing campaigns paid back their budget?",
            "How did the online share of revenue develop month by month?",
        ],
        "analytics_brief": "Analyse Kopi Nusantara's 2025 sales: which channels, cities and product categories drive "
                           "revenue and margin, how Ramadan and the 11.11 / 12.12 shopping days changed sales, and "
                           "which marketing campaigns paid back. Recommend where to focus in 2026.",
        "agent_goal": "Using the attached Kopi Nusantara sales data and web research on current Indonesian coffee chain "
                      "prices (Kopi Kenangan, Fore, Janji Jiwa), check whether our menu prices are competitive and "
                      "write a short pricing report with recommendations.",
        "hints": {"chat": "Try: “Why did revenue change in March 2025?”",
                  "agent": "compare our menu prices with Kopi Kenangan, Fore and Janji Jiwa online",
                  "workflow": "quality check, monthly revenue by channel, growth, a 3-month forecast, AI insights and Excel"},
    },
    "retail": {
        "name": "Pasar Raya Mart", "industry": "Retail", "folder": "pasar_raya_mart",
        "files": ["store_sales.csv", "stores.csv"], "chat_files": ["store_sales.csv", "stores.csv"],
        "agent_files": ["store_sales.csv", "stores.csv"], "generate": _retail, "workflow": _wf_retail,
        "tagline": "Minimarket chain · 10 stores · 6 cities · 2024-2025",
        "description": "A fictional Indonesian supermarket & minimarket chain: daily sales per store and category for "
                       "2024-2025, with payment methods, discounts, returns and margin.",
        "highlights": ["Lebaran shopping rush, then quiet days", "a competitor hits Bekasi Timur from June 2025",
                       "QRIS grows to almost half of sales", "a new store opens in Malang"],
        "metrics": [
            {"term": "Net sales", "definition": "gross_sales - discounts - returns (column net_sales), in IDR"},
            {"term": "Gross margin", "definition": "net_sales - cogs (column gross_margin)"},
            {"term": "Gross margin %", "definition": "gross_margin / net_sales x 100"},
            {"term": "Like-for-like (LFL) sales", "definition": "net sales of stores open for the whole of both periods "
                                                               "compared; exclude Malang Kota (opened 2025-03-01)"},
            {"term": "Spend per transaction", "definition": "net_sales / transactions (transactions are receipts that "
                                                            "include the category)"},
            {"term": "QRIS share", "definition": "qris_sales / net_sales x 100"},
            {"term": "Lebaran", "definition": "Eid al-Fitr: 10 April 2024 and 31 March 2025; the rush is the 14 days before"},
        ],
        "questions": [
            "Why did net sales at Bekasi Timur fall in July 2025 compared with July 2024?",
            "Forecast total net_sales for the next 3 months, with a likely range.",
            "What if Personal care prices rise 3% and volume falls 1%? Show next quarter's net sales against the forecast.",
            "Which stores and categories have the best gross margin %?",
            "How did the 14 days before Lebaran 2025 change sales by category?",
            "How fast is QRIS growing as a share of net sales, by city?",
        ],
        "analytics_brief": "Analyse Pasar Raya Mart's 2024-2025 store sales: like-for-like growth by store and city, "
                           "category mix and margin, the Lebaran effect, payday weeks and the shift to QRIS. Explain "
                           "what happened at Bekasi Timur and recommend where to focus in 2026.",
        "agent_goal": "Using the attached Pasar Raya Mart store sales and web research on how Indonesian minimarket "
                      "chains (Indomaret, Alfamart) compete on promotions and digital payments, write a short plan to "
                      "win back customers at our Bekasi Timur store.",
        "hints": {"chat": "Try: “Why did net sales at Bekasi Timur fall in July 2025?”",
                  "agent": "plan how to win back customers at Bekasi Timur after a competitor opened nearby",
                  "workflow": "quality check, monthly net sales by store, growth, a 3-month forecast and an AI store review"},
    },
    "banking": {
        "name": "BPR Sejahtera Makmur", "industry": "Banking", "folder": "bpr_sejahtera_makmur",
        "files": ["portfolio_monthly.csv", "loans.csv"], "chat_files": ["portfolio_monthly.csv", "loans.csv"],
        "agent_files": ["portfolio_monthly.csv"], "generate": _banking, "workflow": _wf_banking,
        "tagline": "Rural bank loan book · 6 West Java branches · 2023-2025",
        "description": "A fictional rural bank (BPR) in West Java: 6,500 loans with collectibility, plus a monthly "
                       "portfolio summary by branch and product (outstanding, NPL, new disbursement).",
        "highlights": ["a Garut dry season more than doubles its NPL from Q3 2025",
                       "consumer loans sour after Lebaran 2025", "debtor names are masked automatically"],
        "metrics": [
            {"term": "NPL", "definition": "non-performing loans: outstanding of loans in collectibility (Kol) 3, 4 or 5 "
                                          "(column npl_outstanding_idr)"},
            {"term": "NPL ratio", "definition": "npl_outstanding_idr / outstanding_idr x 100, for the same month"},
            {"term": "Collectibility (Kol)", "definition": "1 Lancar = 0 days past due; 2 Dalam Perhatian Khusus = 1-90; "
                                                           "3 Kurang Lancar = 91-120; 4 Diragukan = 121-180; 5 Macet = over 180"},
            {"term": "Balances", "definition": "outstanding_idr, npl_outstanding_idr and kol2_outstanding_idr are month-end "
                                               "balances: compare single months and never add them up across months"},
            {"term": "New disbursement", "definition": "new_disbursement_idr: loans paid out during the month (a flow, "
                                                       "can be summed over months)"},
            {"term": "Average ticket", "definition": "amount_idr / number of loans"},
        ],
        "questions": [
            "Why did NPL outstanding rise in September 2025 compared with June 2025?",
            "What is the NPL ratio by branch and product in December 2025?",
            "Forecast monthly new_disbursement_idr for the next 6 months.",
            "Which sectors and loan officers have the most active loans in collectibility 3-5?",
            "How did new disbursement change in 2025 compared with 2024, by product?",
            "What if KUR Mikro disbursement grows 15% next quarter? Show total new disbursement against the forecast.",
        ],
        "analytics_brief": "Analyse BPR Sejahtera Makmur's loan book for 2023-2025: growth of outstanding and new "
                           "disbursement by branch and product, the NPL trend and what drives it (branch, product, "
                           "sector), and early-warning signs in collectibility 2. Recommend actions for the credit "
                           "committee.",
        "agent_goal": "Using the attached monthly portfolio and web research on the 2025 dry season in West Java and on "
                      "OJK guidance for restructuring micro loans, write a short memo on how BPR Sejahtera Makmur should "
                      "handle rising agriculture NPL in Garut.",
        "hints": {"chat": "Try: “Why did NPL outstanding rise in September 2025?”",
                  "agent": "research the West Java dry season and OJK restructuring rules for a Garut NPL memo",
                  "workflow": "quality check, NPL ratio, NPL by month and branch, and an AI risk review"},
    },
    "marketing": {
        "name": "Batik Lestari", "industry": "Marketing", "folder": "batik_lestari",
        "files": ["campaign_daily.csv"], "chat_files": ["campaign_daily.csv"], "agent_files": ["campaign_daily.csv"],
        "generate": _marketing, "workflow": _wf_marketing,
        "tagline": "Online batik brand · 5 ad channels · 2025",
        "description": "A fictional online batik fashion brand: daily 2025 results for each campaign on Meta, Google "
                       "Search, TikTok, email and influencers (spend, impressions, clicks, orders, revenue).",
        "highlights": ["TikTok gets cheaper month after month", "Meta costs spike around Harbolnas",
                       "Google Search fatigue from September", "a Hari Batik (2 October) influencer burst"],
        "metrics": [
            {"term": "ROAS", "definition": "revenue_idr / spend_idr (return on ad spend)"},
            {"term": "CPA (cost per order)", "definition": "spend_idr / orders"},
            {"term": "CAC", "definition": "spend_idr / new_customers"},
            {"term": "CTR", "definition": "clicks / impressions x 100"},
            {"term": "Conversion rate", "definition": "orders / clicks x 100"},
            {"term": "CPM", "definition": "spend_idr / impressions x 1000"},
        ],
        "questions": [
            "Why did Google Search orders fall in September 2025 compared with August?",
            "Which channel has the best ROAS and cost per order in Q4 2025?",
            "Why did revenue_idr change in Q4 2025 compared with Q3?",
            "Forecast weekly revenue_idr for the next 12 weeks, with a likely range.",
            "What if we move 20% of Meta Ads spend to TikTok Ads? Estimate the revenue impact from each channel's Q4 ROAS.",
            "How much did the Hari Batik influencer campaign add around 2 October?",
        ],
        "analytics_brief": "Analyse Batik Lestari's 2025 marketing: return on ad spend, cost per order and new-customer "
                           "cost by channel and campaign, how the Lebaran and Hari Batik moments performed, and what "
                           "changed in Q4. Recommend the 2026 channel budget split.",
        "agent_goal": "Using the attached campaign results and web research on TikTok Shop and Meta advertising trends "
                      "for Indonesian fashion brands in 2025, write a short 2026 budget plan for Batik Lestari.",
        "hints": {"chat": "Try: “Why did Google Search orders fall in September 2025?”",
                  "agent": "research TikTok Shop and Meta ad trends for a 2026 budget plan",
                  "workflow": "quality check, weekly revenue by channel, spend, unusual days and AI budget advice"},
    },
}
DEFAULT = "fnb"


def _kit(kit_id: str) -> dict:
    k = KITS.get(kit_id or DEFAULT)
    if not k:
        raise KitError(f"Unknown kit {kit_id!r}. Choose one of: {', '.join(KITS)}.")
    return k


def files(kit_id: str = DEFAULT, only=None) -> list:
    """[(filename, bytes)] for a kit, generating its data on first use."""
    k = _kit(kit_id)
    folder = SAMPLES / k["folder"]
    if not all((folder / f).is_file() for f in k["files"]):
        folder.mkdir(parents=True, exist_ok=True)
        k["generate"](folder)
    return [(f, (folder / f).read_bytes()) for f in (only if only is not None else k["files"])]


def catalog() -> list:
    """All kits for the picker (no data is generated)."""
    return [{"id": i, "name": k["name"], "industry": k["industry"], "tagline": k["tagline"],
             "description": k["description"], "highlights": k["highlights"], "files": k["files"],
             "metrics": k["metrics"], "questions": k["questions"], "hints": k["hints"]} for i, k in KITS.items()]


def start_datachat(kit_id: str = DEFAULT) -> dict:
    """A Data chat on the kit's data, carrying its metric definitions and questions (this chat only)."""
    from features import data_chat
    k = _kit(kit_id)
    s = data_chat.create_session(files(kit_id, k["chat_files"]))
    sess = data_chat.get_session(s["id"])
    sess.r["title"] = f"{k['name']} (sample)"
    sess.r["kit"] = {"id": kit_id, "name": k["name"], "metrics": k["metrics"], "questions": k["questions"]}
    sess.save()
    return sess.public()


def analytics_payload(kit_id: str = DEFAULT) -> tuple:
    k = _kit(kit_id)
    return files(kit_id, k["chat_files"]), k["analytics_brief"]


def agent_payload(kit_id: str = DEFAULT) -> tuple:
    k = _kit(kit_id)
    return files(kit_id, k["agent_files"]), k["agent_goal"]


def start_workflow(kit_id: str = DEFAULT) -> dict:
    from features import workflow
    k = _kit(kit_id)
    name, nodes, edges, source, description = k["workflow"]()
    w = workflow.create(name, nodes, edges, description)
    for fname, data in files(kit_id, [source]):
        workflow.add_file(w["id"], fname, data)
    return workflow.get(w["id"])

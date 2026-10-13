"""
features/samples.py – sample data and a guided first run.

"Kopi Nusantara" is a FICTIONAL Indonesian coffee & snacks chain (2025, 8 cities, 5 channels).
The data is generated deterministically (fixed seed) on first use into data/samples/kopi_nusantara/
and has patterns worth finding:

  * Ramadan (1–30 March 2025): store visits drop, delivery (GoFood) rises;
  * Harbolnas 11.11 and 12.12: big spikes on Shopee and Tokopedia;
  * online channels grow from about 35% to 58% of revenue; Coffee drinks have the best margin, Pastry the worst;
  * an Independence Day promo on 17 August; a few rows with a blank region (for quality checks);
  * short customer reviews (for AI classify) and fake customer emails (to show personal-data masking).

The starters below hand the sample to each app: a Data chat session, Analytics upload ids,
Agent attachments, and a ready-made Workflow.
"""

import random
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_DIR = ROOT / "data" / "samples" / "kopi_nusantara"
FILES = ("sales_2025.csv", "customers.csv", "campaigns.csv")
NAME = "Kopi Nusantara (sample)"

REGIONS = [("Jakarta", 0.30), ("Surabaya", 0.14), ("Bandung", 0.13), ("Medan", 0.10), ("Semarang", 0.08),
           ("Yogyakarta", 0.09), ("Denpasar", 0.08), ("Makassar", 0.08)]
PRODUCTS = [  # name, category, price (IDR), unit cost
    ("Es Kopi Susu Gula Aren", "Coffee drinks", 22000, 7600), ("Americano", "Coffee drinks", 20000, 5200),
    ("Cafe Latte", "Coffee drinks", 28000, 9100), ("Cappuccino", "Coffee drinks", 28000, 9000),
    ("Kopi Tubruk", "Coffee drinks", 15000, 3900), ("Caramel Macchiato", "Coffee drinks", 33000, 11800),
    ("Matcha Latte", "Non-coffee", 30000, 11200), ("Cokelat Panas", "Non-coffee", 25000, 8700),
    ("Teh Tarik", "Non-coffee", 18000, 5900), ("Es Jeruk", "Non-coffee", 16000, 5600),
    ("Croissant Butter", "Pastry", 24000, 13900), ("Roti Bakar Cokelat Keju", "Pastry", 22000, 12600),
    ("Banana Bread", "Pastry", 20000, 11500), ("Pisang Goreng", "Pastry", 15000, 8400),
    ("Gayo Arabica Beans 250g", "Beans & Retail", 95000, 38000), ("Toraja Beans 250g", "Beans & Retail", 105000, 41000),
    ("Drip Bag Box (10)", "Beans & Retail", 65000, 24500), ("Tumbler Kopi Nusantara", "Merchandise", 120000, 52000),
    ("Tote Bag", "Merchandise", 75000, 33000),
]
RETAIL = [14, 15, 16, 17, 18]                       # indexes of beans / merchandise (what marketplaces sell)
SEGMENTS = [("Office worker", 0.42), ("Student", 0.27), ("Family", 0.21), ("Corporate", 0.10)]
GOOD = ["Kopinya enak, pasti beli lagi", "Great coffee and fast delivery", "Barista ramah, tempat nyaman",
        "Love the gula aren latte", "Packaging rapi, masih dingin waktu sampai", "Best croissant in town"]
OKAY = ["Lumayan, harga standar", "Okay but a bit sweet", "Biasa saja", "Fine, nothing special"]
BAD = ["Pengiriman telat 40 menit", "Too expensive for the size", "Pesanan salah, kurang satu",
       "Kopi sudah dingin waktu sampai", "Croissant agak keras", "Antrian lama sekali"]


def _pick(rng, pairs):
    r, acc = rng.random() * sum(w for _, w in pairs), 0.0
    for v, w in pairs:
        acc += w
        if r <= acc:
            return v
    return pairs[-1][0]


def _generate():
    rng = random.Random(2025)
    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)

    customers = []
    for i in range(1, 1801):
        signup = date(2023, 1, 1) + timedelta(days=rng.randint(0, 900))
        customers.append({"customer_id": i, "email": f"customer{i:04d}@example.com",
                          "segment": _pick(rng, SEGMENTS), "gender": rng.choice(["F", "M"]),
                          "age": max(17, min(65, int(rng.gauss(31, 9)))), "region": _pick(rng, REGIONS),
                          "is_member": rng.random() < 0.38, "signup_date": signup.isoformat()})

    campaigns = [
        ("Ramadan Ngabuburit Deals", "GoFood", "2025-03-01", "2025-03-30", 45_000_000, 620, 186_000_000),
        ("Harbolnas 11.11", "Shopee", "2025-11-09", "2025-11-12", 30_000_000, 480, 154_000_000),
        ("Harbolnas 12.12", "Tokopedia", "2025-12-10", "2025-12-13", 32_000_000, 455, 149_000_000),
        ("Merdeka 17 Agustus Promo", "Store", "2025-08-15", "2025-08-18", 25_000_000, 300, 97_000_000),
        ("Back to Campus", "Website", "2025-07-14", "2025-08-10", 28_000_000, 410, 71_000_000),
        ("Member Double Points", "Store", "2025-05-01", "2025-05-31", 18_000_000, 150, 64_000_000),
    ]

    rows, oid = [], 100000
    day = date(2025, 1, 1)
    while day <= date(2025, 12, 31):
        progress = (day - date(2025, 1, 1)).days / 365
        ramadan = date(2025, 3, 1) <= day <= date(2025, 3, 30)
        harbolnas = (day.month, day.day) in ((11, 11), (12, 12))
        n = (26 + (6 if day.weekday() >= 5 else 0)) * (0.85 if ramadan else 1.0)
        n *= 2.1 if day == date(2025, 8, 17) else 3.2 if harbolnas else 1.0
        for _ in range(max(5, int(rng.gauss(n, n * 0.12)))):
            oid += 1
            online = 0.30 + 0.20 * progress
            weights = [("Store", 1 - online), ("Website", online * 0.22), ("GoFood", online * 0.40),
                       ("Shopee", online * 0.20), ("Tokopedia", online * 0.18)]
            if ramadan:
                weights = [(c, w * (0.6 if c == "Store" else 1.5 if c == "GoFood" else 1.0)) for c, w in weights]
            if harbolnas:
                weights = [(c, w * (4.0 if c in ("Shopee", "Tokopedia") else 0.7)) for c, w in weights]
            channel = _pick(rng, weights)
            cust = customers[rng.randrange(len(customers))]
            promo = (ramadan and channel == "GoFood") or (harbolnas and channel in ("Shopee", "Tokopedia")) \
                or day == date(2025, 8, 17)
            discount = rng.choice([10, 15, 20, 25]) if promo else rng.choice([0, 0, 0, 0, 5, 10])
            region = cust["region"] if rng.random() > 0.004 else ""                 # a few blanks to find
            for _ in range(rng.choice([1, 1, 1, 2, 2, 3])):
                idx = rng.randrange(len(PRODUCTS))
                if channel in ("Shopee", "Tokopedia") and idx not in RETAIL and rng.random() < 0.7:
                    idx = rng.choice(RETAIL)
                name, cat, price, cost = PRODUCTS[idx]
                qty = rng.choice([1, 1, 1, 2, 2, 3])
                revenue = round(price * qty * (1 - discount / 100))
                rating = rng.choices([5, 4, 3, 2, 1], weights=[42, 30, 14, 9, 5])[0]
                if channel == "GoFood" and rng.random() < 0.08:
                    rating = rng.choice([1, 2])
                review = ""
                if rng.random() < 0.18:
                    review = rng.choice(GOOD if rating >= 4 else OKAY if rating == 3 else BAD)
                rows.append({"order_id": oid, "order_date": day.isoformat(), "channel": channel, "region": region,
                             "customer_id": cust["customer_id"], "customer_email": cust["email"],
                             "segment": cust["segment"], "is_member": cust["is_member"], "product": name,
                             "category": cat, "quantity": qty, "unit_price": price, "discount_pct": discount,
                             "revenue": revenue, "cost": cost * qty, "gross_profit": revenue - cost * qty,
                             "rating": rating, "review": review})
        day += timedelta(days=1)

    pd.DataFrame(rows).to_csv(SAMPLE_DIR / "sales_2025.csv", index=False)
    pd.DataFrame(customers).to_csv(SAMPLE_DIR / "customers.csv", index=False)
    pd.DataFrame(campaigns, columns=["campaign", "channel", "start_date", "end_date", "budget_idr",
                                     "new_customers", "attributed_revenue_idr"]).to_csv(SAMPLE_DIR / "campaigns.csv", index=False)


def files() -> list:
    """[(filename, bytes)] for the sample, generating it on first use."""
    if not all((SAMPLE_DIR / f).is_file() for f in FILES):
        _generate()
    return [(f, (SAMPLE_DIR / f).read_bytes()) for f in FILES]


def info() -> dict:
    f = files()
    sales = pd.read_csv(SAMPLE_DIR / "sales_2025.csv", usecols=["order_id"])
    return {"name": NAME, "files": [{"name": n, "size": len(b)} for n, b in f],
            "orders": int(sales["order_id"].nunique()), "rows": int(len(sales)),
            "description": "A fictional Indonesian coffee & snacks chain: 2025 sales across 8 cities and 5 channels, "
                           "customers and marketing campaigns."}


# ── Starters for each app ───────────────────────────────────────────────────

ANALYTICS_BRIEF = ("Analyse Kopi Nusantara's 2025 sales: which channels, cities and product categories drive revenue "
                   "and margin, how Ramadan and the 11.11 / 12.12 shopping days changed sales, and which marketing "
                   "campaigns paid back. Recommend where to focus in 2026.")
AGENT_GOAL = ("Using the attached Kopi Nusantara sales data and web research on current Indonesian coffee chain "
              "prices (Kopi Kenangan, Fore, Janji Jiwa), check whether our menu prices are competitive and write a "
              "short pricing report with recommendations.")


def start_datachat() -> dict:
    from features import data_chat
    s = data_chat.create_session([(n, b) for n, b in files() if n != "customers.csv"])
    sess = data_chat.get_session(s["id"])
    sess.r["title"] = NAME
    sess.save()
    return sess.public()


def start_workflow() -> dict:
    """A ready-made workflow on the sample: monthly revenue per channel, growth, a chart, AI insights and an export."""
    from features import workflow

    def N(i, t, label, cfg, x, y):
        return {"id": i, "type": t, "label": label, "position": {"x": x, "y": y}, "config": cfg}

    nodes = [
        N("src", "upload", "Sample sales", {"file": "sales_2025.csv"}, 0, 120),
        N("qc", "quality_check", "Check the data", {"rules": "not_null: order_id, revenue\nnot_null: region\nbetween: rating, 1, 5",
                                                     "on_fail": "continue"}, 260, 120),
        N("month", "date_tools", "Month", {"column": "order_date", "operation": "month"}, 520, 120),
        N("agg", "aggregate", "Revenue by month & channel", {"group_by": ["order_date_month", "channel"],
                                                              "column": "revenue", "function": "sum"}, 780, 120),
        N("growth", "calculate", "Month-on-month growth", {"operation": "pct_change", "column": "revenue",
                                                           "order_by": "order_date_month", "group_by": ["channel"],
                                                           "new_column": "growth_pct"}, 1040, 40),
        N("chart", "chart", "Revenue by channel", {"kind": "line", "x": "order_date_month", "y": "revenue",
                                                   "color": "channel", "title": "Monthly revenue by channel, 2025"}, 1040, 220),
        N("ai", "ai_insights", "What changed?", {"mode": "insights"}, 1300, 40),
        N("export", "export", "Excel", {"format": "xlsx", "filename": "kopi_nusantara_monthly"}, 1300, 220),
    ]
    edges = [{"source": a, "target": b} for a, b in (("src", "qc"), ("qc", "month"), ("month", "agg"), ("agg", "growth"),
                                                       ("agg", "chart"), ("growth", "ai"), ("growth", "export"))]
    w = workflow.create("Kopi Nusantara · monthly channel check (sample)", nodes, edges,
                        "Sample workflow: checks the data, sums revenue per month and channel, computes growth, "
                        "draws a chart, asks the AI what changed and exports to Excel. Press Run.")
    for name, data in files():
        if name == "sales_2025.csv":
            workflow.add_file(w["id"], name, data)
    return workflow.get(w["id"])

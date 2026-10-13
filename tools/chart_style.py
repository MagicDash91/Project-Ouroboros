"""
tools/chart_style.py – one light, modern look for every generated chart.

Editorial style to match the web app: white canvas, ink text, a single accent
(vermilion) for the bar that matters and muted slate for the rest, no chart junk
(no top/right spines, faint horizontal grid only), left-aligned headline + subtitle.
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.ticker import FuncFormatter

INK     = "#1F2328"
MUTED   = "#6B7280"
FAINT   = "#9CA3AF"
GRID    = "#ECEEF1"
CANVAS  = "#FFFFFF"
ACCENT  = "#E4572E"   # the one thing the eye should land on
BASE    = "#B8C2CC"   # everything else
SERIES  = ["#2F5D8C", "#E4572E", "#3BA99C", "#F2A541", "#7C5CBF", "#8C9BAB"]
DIVERGE = LinearSegmentedColormap.from_list("diverge", ["#2F5D8C", "#F7F7F5", "#E4572E"])

FIG_W, FIG_H, DPI = 10, 5.6, 160   # 1600×896 px — fits slides and the web card

# Palette handed to Claude-written chart code (tools/chart_runner.py) as THEME.
THEME = {"accent": ACCENT, "base": BASE, "series": SERIES, "ink": INK, "muted": MUTED,
         "grid": GRID, "background": CANVAS, "font": "Segoe UI"}


def apply_theme() -> None:
    plt.rcParams.update({
        "font.family": ["Segoe UI", "Calibri", "DejaVu Sans"],
        "font.size": 10.5,
        "text.color": INK,
        "axes.facecolor": CANVAS,
        "figure.facecolor": CANVAS,
        "savefig.facecolor": CANVAS,
        "axes.edgecolor": GRID,
        "axes.labelcolor": MUTED,
        "axes.labelsize": 10,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.spines.left": False,
        "axes.grid": True,
        "axes.grid.axis": "y",
        "axes.axisbelow": True,
        "grid.color": GRID,
        "grid.linewidth": 0.9,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "xtick.major.size": 0,
        "ytick.major.size": 0,
        "legend.frameon": False,
        "legend.fontsize": 9.5,
        "axes.prop_cycle": plt.cycler(color=SERIES),
    })


def new_figure(w: float = FIG_W, h: float = FIG_H):
    apply_theme()
    fig, ax = plt.subplots(figsize=(w, h))
    fig.subplots_adjust(left=0.08, right=0.97, top=0.80, bottom=0.14)
    return fig, ax


def frame(fig, title: str, subtitle: str = "", source: str = "") -> None:
    """Left-aligned headline, muted subtitle, small source note."""
    fig.text(0.02, 0.95, title, fontsize=15, fontweight="bold", color=INK, ha="left", va="top")
    if subtitle:
        fig.text(0.02, 0.885, subtitle, fontsize=10.5, color=MUTED, ha="left", va="top")
    if source:
        fig.text(0.02, 0.02, source, fontsize=8.5, color=FAINT, ha="left", va="bottom")


def highlight_colors(n: int, index: int = 0) -> list:
    return [ACCENT if i == index else BASE for i in range(n)]


def fmt_number(v: float, kind: str = "number") -> str:
    if v is None:
        return ""
    if kind == "percent":
        return f"{v:.0f}%" if float(v).is_integer() else f"{v:.1f}%"
    a = abs(v)
    if a >= 1e9:
        return f"{v / 1e9:.1f}B"
    if a >= 1e6:
        return f"{v / 1e6:.1f}M"
    if a >= 1e4:
        return f"{v / 1e3:.0f}k"
    if a >= 1e3:
        return f"{v:,.0f}"
    if a >= 100 or float(v).is_integer():
        return f"{v:.0f}"
    return f"{v:.1f}" if a >= 1 else f"{v:.2f}"


def axis_formatter(kind: str = "number") -> FuncFormatter:
    return FuncFormatter(lambda v, _: fmt_number(v, kind))


def save(fig, path: str) -> str:
    fig.savefig(path, dpi=DPI)
    plt.close(fig)
    return path

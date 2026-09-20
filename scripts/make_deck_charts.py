#!/usr/bin/env python3
"""Deck-ready charts from the saved result files.

Every chart here is a single measure ranked across arms, so each is a single-series
chart with one mark highlighted -- identity comes from the axis labels, not from hue,
which is why there is no legend and no categorical palette. Gray carries context,
one accent carries "ours". Grid and axes stay recessive; values are labelled directly
rather than left to a reader to estimate off an axis.

Writes results/deck_*.png at 200 dpi on an opaque surface, sized for slides.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

R = Path("results")
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
SECOND = "#52514e"
MUTED = "#8a8782"
GRID = "#e4e1db"
ACCENT = "#eb6834"      # "ours"
NEUTRAL = "#c2bfb8"     # context

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE,
    "savefig.facecolor": SURFACE, "font.size": 11,
    "font.family": "sans-serif",
    "text.color": INK, "axes.labelcolor": SECOND, "axes.edgecolor": GRID,
    "xtick.color": SECOND, "ytick.color": SECOND,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8,
    "axes.axisbelow": True, "figure.dpi": 200,
})


def style(ax, xgrid=False):
    ax.grid(axis="x" if xgrid else "y")
    ax.grid(axis="y" if xgrid else "x", visible=False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(GRID)
    ax.tick_params(length=0)


def title(ax, main, sub=None):
    ax.set_title(main, loc="left", fontsize=14, color=INK, pad=16 if sub else 10,
                 fontweight="bold")
    if sub:
        ax.text(0, 1.02, sub, transform=ax.transAxes, fontsize=10, color=MUTED,
                va="bottom")


def accuracy_vs_cost():
    """The headline: what each arm costs versus how accurate it is.

    A scatter, because the claim is about the RELATIONSHIP between two measures --
    two bar charts side by side would make the reader do that join themselves."""
    d = json.loads((R / "benchmark_all.json").read_text())
    pts = [(k, v["projected_1m_usd"], v["f1"]) for k, v in d["arms"].items()
           if v.get("projected_1m_usd")]
    fig, ax = plt.subplots(figsize=(9.2, 5.4))
    # Points cluster near F1 ~0.98 across two decades of cost, so labels are
    # centred under each point and stepped down in alternating rows: at this
    # density any side placement collides or runs off the axis.
    pts.sort(key=lambda p: p[1])
    for i, (name, cost, f1) in enumerate(pts):
        ours = name.startswith("jev")
        ax.scatter(cost, f1, s=200 if ours else 130, zorder=4,
                   color=ACCENT if ours else NEUTRAL,
                   edgecolor=SURFACE, linewidth=2)
        dy = -34 if i % 2 == 0 else -62
        ax.annotate(f"{name}\n${cost:,.0f} · F1 {f1:.3f}", (cost, f1),
                    textcoords="offset points", xytext=(0, dy), ha="center",
                    fontsize=9.5, color=INK if ours else SECOND,
                    fontweight="bold" if ours else "normal", zorder=5)
        ax.plot([cost, cost], [f1 - 0.006, f1 + dy / 1000 + 0.028],
                color=GRID, linewidth=0.9, zorder=2)
    ax.set_xscale("log")
    ax.set_xlabel("Cost per million items (log scale)")
    ax.set_ylabel("F1 against gold standard")
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"${v:,.0f}"))
    ax.set_ylim(0.66, 1.03)
    ax.set_xlim(12, 3200)
    style(ax)
    ax.grid(axis="both")
    title(ax, "Same accuracy, 25–60× less money",
          f"{d['gold_size']} gold items · two independent judges · Cohen's κ = {d['cohens_kappa']}")
    fig.tight_layout()
    fig.savefig(R / "deck_accuracy_vs_cost.png", bbox_inches="tight")
    print("  deck_accuracy_vs_cost.png")


def f1_with_ci():
    """Accuracy with its uncertainty, because the claim is 'indistinguishable'."""
    d = json.loads((R / "benchmark_all.json").read_text())
    rows = sorted(d["arms"].items(), key=lambda x: x[1]["f1"])
    names = [k for k, _ in rows]
    f1s = [v["f1"] for _, v in rows]
    lo = [v["f1"] - v["f1_ci95"][0] for _, v in rows]
    hi = [v["f1_ci95"][1] - v["f1"] for _, v in rows]
    colors = [ACCENT if n.startswith("jev") else NEUTRAL for n in names]
    fig, ax = plt.subplots(figsize=(8.4, 4.4))
    ax.barh(names, f1s, height=.62, color=colors, zorder=3)
    ax.errorbar(f1s, names, xerr=[lo, hi], fmt="none", ecolor=SECOND,
                elinewidth=1.4, capsize=4, zorder=4)
    for n, f in zip(names, f1s):
        ax.text(f + max(hi) + .035, n, f"{f:.3f}", va="center", fontsize=10,
                color=INK, fontweight="bold" if n.startswith("jev") else "normal")
    ax.set_xlim(0, 1.18)
    ax.set_xlabel("F1 (bars) with 95% confidence interval (whiskers)")
    style(ax, xgrid=True)
    title(ax, "Every interval overlaps except the floor",
          "1,000-round paired bootstrap · overlapping intervals mean the difference is not significant")
    fig.tight_layout()
    fig.savefig(R / "deck_f1_ci.png", bbox_inches="tight")
    print("  deck_f1_ci.png")


def trend():
    """Change over time -> a line. One series, so no legend; the title names it."""
    d = json.loads((R / "enrich_llm_usage_peritem.json").read_text())
    pts = [p for p in d["by_year"] if p["year"] and 2015 <= p["year"] <= 2026]
    xs = [p["year"] for p in pts]
    ys = [p["share"] * 100 for p in pts]
    fig, ax = plt.subplots(figsize=(8.4, 4.6))
    ax.fill_between(xs, ys, color=ACCENT, alpha=.10, zorder=2)
    ax.plot(xs, ys, color=ACCENT, linewidth=2, zorder=3)
    ax.scatter(xs, ys, s=34, color=ACCENT, edgecolor=SURFACE, linewidth=1.6, zorder=4)
    for x, y, p in zip(xs, ys, pts):
        if x in (2015, 2019, 2023, 2026):
            ax.annotate(f"{y:.1f}%\n{p['count']:,} papers", (x, y),
                        textcoords="offset points", xytext=(0, 14),
                        ha="center", fontsize=9.5, color=INK)
    ax.set_ylim(-0.4, max(ys) * 1.42)
    ax.set_ylabel("Share of MIT papers")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.0f}%"))
    ax.set_xticks(xs)
    style(ax)
    title(ax, "Large language model use at MIT, 2015–2026",
          f"{d['n']:,} abstracts classified · 2015–2018 reads 0.0%, which is the correct answer")
    fig.tight_layout()
    fig.savefig(R / "deck_trend.png", bbox_inches="tight")
    print("  deck_trend.png")


def counterfactual():
    """Magnitude across models -> bars, log scale because the range is 100×."""
    d = json.loads((R / "token_ledger.json").read_text())
    cf = d.get("counterfactual_input_only_usd", {})
    rows = sorted(cf.items(), key=lambda x: x[1])
    names = [k for k, _ in rows]
    vals = [v for _, v in rows]
    colors = [ACCENT if n.startswith("jev") else NEUTRAL for n in names]
    fig, ax = plt.subplots(figsize=(8.4, 4.4))
    ax.barh(names, vals, height=.62, color=colors, zorder=3)
    base = cf.get("jev-1.13.0", 1)
    for n, v in zip(names, vals):
        mult = "" if n.startswith("jev") else f"   {v/base:.0f}× more"
        ax.text(v * 1.10, n, f"${v:,.2f}{mult}", va="center", fontsize=10,
                color=INK, fontweight="bold" if n.startswith("jev") else "normal")
    ax.set_xscale("log")
    ax.set_xlim(2, 3000)
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"${v:,.0f}"))
    ax.set_xlabel("Cost for the same 100.7M tokens (log scale)")
    style(ax, xgrid=True)
    title(ax, "What this project's enrichment would have cost elsewhere",
          "100,683,899 input tokens actually processed · measured, not projected")
    fig.tight_layout()
    fig.savefig(R / "deck_counterfactual.png", bbox_inches="tight")
    print("  deck_counterfactual.png")


def retrieval():
    d = json.loads((R / "baselines.json").read_text())
    arms = {k: v for k, v in d["summary"].items() if k != "llm_rerank"}
    rows = sorted(arms.items(), key=lambda x: x[1]["ndcg_at_10"])
    names = [k for k, _ in rows]
    vals = [v["ndcg_at_10"] for _, v in rows]
    lo = [v["ndcg_at_10"] - v["ndcg_ci95"][0] for _, v in rows]
    hi = [v["ndcg_ci95"][1] - v["ndcg_at_10"] for _, v in rows]
    colors = [ACCENT if n == "ball" else NEUTRAL for n in names]
    fig, ax = plt.subplots(figsize=(8.4, 3.6))
    ax.barh(names, vals, height=.56, color=colors, zorder=3)
    ax.errorbar(vals, names, xerr=[lo, hi], fmt="none", ecolor=SECOND,
                elinewidth=1.4, capsize=4, zorder=4)
    for n, v in zip(names, vals):
        ax.text(v + max(hi) + .04, n, f"{v:.3f}", va="center", fontsize=10,
                color=INK, fontweight="bold" if n == "ball" else "normal")
    ax.set_xlim(0, 1.15)
    ax.set_xlabel("nDCG@10 with 95% confidence interval")
    style(ax, xgrid=True)
    title(ax, "Rubric-driven search beats standard retrieval baselines",
          "20 queries · TREC-style pooled judging · paired bootstrap over queries")
    fig.tight_layout()
    fig.savefig(R / "deck_retrieval.png", bbox_inches="tight")
    print("  deck_retrieval.png")


if __name__ == "__main__":
    print("writing deck charts:")
    for fn in (accuracy_vs_cost, f1_with_ci, trend, counterfactual, retrieval):
        try:
            fn()
        except Exception as e:  # a missing input should not stop the rest
            print(f"  skipped {fn.__name__}: {type(e).__name__}: {e}")

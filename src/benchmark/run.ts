/**
 * Benchmark orchestration.
 * Protocol (fixed before seeing results):
 * - TRAIN cutoff: fit logistic-regression candidates (grid in model.ts).
 * - DEV cutoff(s): select ONE priority-index weight set and ONE LR
 *   hyperparameter set by mean NDCG@20; tie-breaks: higher mean P@20,
 *   then earlier candidate order (deterministic, declared here).
 * - HELD-OUT cutoff: evaluate the selected approach plus ALL fixed
 *   comparators (never re-select on held-out).
 * Every ranker sees the identical eligible population at each cutoff.
 */
import type Database from "better-sqlite3";
import {
  PRIORITY_WEIGHT_SETS,
  buildFixedRankers,
  rank,
  type Ranker,
} from "./algorithms.js";
import { assertSamePopulation, getEligiblePopulation } from "./eligibility.js";
import {
  buildAllFeatures,
  loadOutcomes,
  loadSnapshot,
  type FeatureVector,
} from "./features.js";
import { JEV_RANKER_META, loadJevScores, rankJev } from "./jev.js";
import { evaluateRanking, type AlgorithmMetrics } from "./metrics.js";
import { LR_GRID, lrRanker, trainLogistic, type LRModel } from "./model.js";
import { DATASET_VERSION } from "../config.js";

export const BENCHMARK_VERSION = "1.0.0";
export const WINDOW_DAYS = 90;

export interface CutoffResult {
  rankerId: string;
  family: string;
  description: string;
  metrics: AlgorithmMetrics;
  runtimeMs: number;
}

export interface CutoffReport {
  t0: string;
  windowEnd: string;
  eligibleN: number;
  donorCount: number;
  results: CutoffResult[];
}

export interface SelectionRecord {
  scope: string;
  candidates: string[];
  criterion: string;
  devScores: { candidate: string; meanNdcgAt20: number; meanPrecisionAt20: number }[];
  selected: string;
}

export interface BenchmarkReport {
  benchmarkVersion: string;
  datasetVersion: string;
  dbPath: string;
  trainCutoff: string;
  devCutoffs: string[];
  heldOutCutoff: string;
  windowDays: number;
  outcomeDefinition: string;
  populationDefinition: string;
  selection: SelectionRecord[];
  dev: CutoffReport[];
  heldOut: CutoffReport;
  selectedPriorityIndex: string;
  selectedLr: string;
  jevMerged: boolean;
}

function evaluateCutoff(
  db: Database.Database,
  t0: string,
  rankers: Ranker[],
  jevPath?: string,
): CutoffReport {
  const population = getEligiblePopulation(db, t0);
  const popIds = population.map((p) => p.id);
  const snap = loadSnapshot(db, t0);
  const features = buildAllFeatures(db, population, t0, snap);
  const { donors, amounts } = loadOutcomes(db, t0, WINDOW_DAYS);

  const results: CutoffResult[] = [];
  for (const r of rankers) {
    const s = Date.now();
    const ranked = rank(r, features, popIds);
    assertSamePopulation(ranked, popIds, `${r.id}@${t0}`);
    const metrics = evaluateRanking(ranked, donors, amounts);
    results.push({
      rankerId: r.id,
      family: r.family,
      description: r.description,
      metrics,
      runtimeMs: Date.now() - s,
    });
  }
  if (jevPath) {
    const s = Date.now();
    const jev = loadJevScores(jevPath, popIds);
    const ranked = rankJev(jev, popIds);
    results.push({
      rankerId: JEV_RANKER_META.id,
      family: JEV_RANKER_META.family,
      description: `${JEV_RANKER_META.description} source=${jev.source}`,
      metrics: evaluateRanking(ranked, donors, amounts),
      runtimeMs: Date.now() - s,
    });
  }
  // Leaderboard order is presentational only; selection never uses it.
  results.sort(
    (a, b) =>
      b.metrics.ndcgAt20 - a.metrics.ndcgAt20 ||
      b.metrics.precisionAt20 - a.metrics.precisionAt20 ||
      (a.rankerId < b.rankerId ? -1 : 1),
  );
  return {
    t0,
    windowEnd: t0,
    eligibleN: popIds.length,
    donorCount: donors.size,
    results,
  };
}

/** Mean NDCG@20 over dev cutoffs; deterministic tie-breaks per protocol. */
function selectBest(
  devReports: CutoffReport[],
  candidateIds: string[],
  scope: string,
): SelectionRecord {
  const devScores = candidateIds.map((candidate, order) => {
    let ndcg = 0;
    let prec = 0;
    for (const rep of devReports) {
      const row = rep.results.find((r) => r.rankerId === candidate)!;
      ndcg += row.metrics.ndcgAt20;
      prec += row.metrics.precisionAt20;
    }
    return {
      candidate,
      order,
      meanNdcgAt20: Math.round((ndcg / devReports.length) * 10000) / 10000,
      meanPrecisionAt20: Math.round((prec / devReports.length) * 10000) / 10000,
    };
  });
  const sorted = [...devScores].sort(
    (a, b) =>
      b.meanNdcgAt20 - a.meanNdcgAt20 ||
      b.meanPrecisionAt20 - a.meanPrecisionAt20 ||
      a.order - b.order,
  );
  return {
    scope,
    candidates: candidateIds,
    criterion: "mean NDCG@20 over dev cutoffs; tie-break mean P@20, then declared candidate order",
    devScores: devScores.map(({ candidate, meanNdcgAt20, meanPrecisionAt20 }) => ({
      candidate,
      meanNdcgAt20,
      meanPrecisionAt20,
    })),
    selected: sorted[0]!.candidate,
  };
}

export interface RunOptions {
  dbPath: string;
  trainCutoff: string;
  devCutoffs: string[];
  heldOutCutoff: string;
  jevPath?: string;
}

export function runBenchmark(db: Database.Database, opts: RunOptions): BenchmarkReport {
  const fixed = buildFixedRankers();

  // Train LR candidates once on the TRAIN cutoff.
  const trainPop = getEligiblePopulation(db, opts.trainCutoff);
  const trainSnap = loadSnapshot(db, opts.trainCutoff);
  const trainFeats = buildAllFeatures(db, trainPop, opts.trainCutoff, trainSnap);
  const trainOut = loadOutcomes(db, opts.trainCutoff, WINDOW_DAYS);
  const trainLabels = new Map<number, number>();
  for (const id of trainPop.map((p) => p.id)) {
    trainLabels.set(id, trainOut.donors.has(id) ? 1 : 0);
  }
  const trainArray: FeatureVector[] = [...trainFeats.values()];
  const lrModels = new Map<string, LRModel>();
  for (const hp of LR_GRID) {
    const fit = trainLogistic(trainArray, trainLabels, hp);
    lrModels.set(hp.id, { hyperId: hp.id, ...fit });
  }
  const lrRankers: Ranker[] = LR_GRID.map((hp) =>
    lrRanker(lrModels.get(hp.id)!, hp.id),
  );
  const allRankers: Ranker[] = [...fixed, ...lrRankers];

  // DEV: evaluate everything, select one priority set + one LR config.
  const dev = opts.devCutoffs.map((t0) => evaluateCutoff(db, t0, allRankers, undefined));
  const prioritySel = selectBest(
    dev,
    PRIORITY_WEIGHT_SETS.map((w) => w.id),
    "priority_index_weight_set",
  );
  const lrSel = selectBest(
    dev,
    LR_GRID.map((h) => `trained_lr_${h.id}`),
    "trained_lr_hyperparams",
  );

  // HELD-OUT: selected approach + all fixed comparators (+ all LR for transparency).
  const heldOut = evaluateCutoff(db, opts.heldOutCutoff, allRankers, opts.jevPath);

  // Fix windowEnd labels to real dates.
  const withEnd = (rep: CutoffReport): CutoffReport => ({
    ...rep,
    windowEnd: addDaysStr(rep.t0, WINDOW_DAYS),
  });

  return {
    benchmarkVersion: BENCHMARK_VERSION,
    datasetVersion: DATASET_VERSION,
    dbPath: opts.dbPath,
    trainCutoff: opts.trainCutoff,
    devCutoffs: opts.devCutoffs,
    heldOutCutoff: opts.heldOutCutoff,
    windowDays: WINDOW_DAYS,
    outcomeDefinition:
      "paid gifts (status='paid', gift_type != 'recurring_parent') with gift_date in (T0, T0+90d], excluding gifts after deceased_date",
    populationDefinition:
      "entity_type='individual' AND deceased=0 AND (deceased_date NULL or > T0) AND do_not_solicit=0 AND (email deliverable OR phone available); identical id set for every ranker",
    selection: [prioritySel, lrSel],
    dev: dev.map(withEnd),
    heldOut: withEnd(heldOut),
    selectedPriorityIndex: prioritySel.selected,
    selectedLr: lrSel.selected,
    jevMerged: opts.jevPath !== undefined,
  };
}

function addDaysStr(ymdStr: string, days: number): string {
  return new Date(Date.parse(`${ymdStr}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Human-readable markdown/table rendering of the held-out leaderboard. */
export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# GiveCampus worklist benchmark v${report.benchmarkVersion}`);
  lines.push("");
  lines.push(`Dataset v${report.datasetVersion}; train=${report.trainCutoff} dev=${report.devCutoffs.join(",")} held-out=${report.heldOutCutoff}; window=${report.windowDays}d.`);
  lines.push(`Population: ${report.populationDefinition}`);
  lines.push(`Outcome: ${report.outcomeDefinition}`);
  lines.push(`Selection: ${report.selection.map((s) => `${s.scope} -> ${s.selected} (${s.criterion})`).join(" | ")}`);
  lines.push("");
  const h = report.heldOut;
  lines.push(`## Held-out leaderboard @ ${h.t0} -> ${h.windowEnd} (N=${h.eligibleN}, donors=${h.donorCount})`);
  lines.push("");
  lines.push(`| ranker | family | P@20 | P@100 | NDCG@20 | NDCG@100 | hits@20 | hits@100 | paid$ top100 (descr) | ms |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of h.results) {
    const m = r.metrics;
    lines.push(
      `| ${r.rankerId} | ${r.family} | ${m.precisionAt20.toFixed(4)} | ${m.precisionAt100.toFixed(4)} | ${m.ndcgAt20.toFixed(4)} | ${m.ndcgAt100.toFixed(4)} | ${m.hitsAt20} | ${m.hitsAt100} | ${m.amountTop100.toFixed(2)} | ${r.runtimeMs} |`,
    );
  }
  lines.push("");
  lines.push(`Selected approach: priority_index=${report.selectedPriorityIndex}, trained=${report.selectedLr}.`);
  lines.push(`paid$ is descriptive only, never a ranking objective. Scores are ordinal ranks, not probabilities.`);
  if (!report.jevMerged) {
    lines.push(`Jev-enhanced results not yet merged; pass --jev jev_scores.csv to join the same leaderboard.`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Simple trained comparator: L2-regularized logistic regression on the six
 * standardized priority-index subscores [r,f,m,e,n,c]. No new dependencies.
 * Temporal protocol: fit on TRAIN cutoff features + TRAIN window labels,
 * hyperparameters selected on DEV cutoff, final report on HELD-OUT cutoff.
 * Deterministic: zero init, fixed order full-batch gradient descent.
 */
import type { FeatureVector } from "./features.js";

export interface LRHyperparams {
  lr: number;
  l2: number;
  epochs: number;
}

export const LR_GRID: (LRHyperparams & { id: string })[] = [
  { id: "lr_a", lr: 0.1, l2: 1.0, epochs: 500 },
  { id: "lr_b", lr: 0.5, l2: 1.0, epochs: 500 },
  { id: "lr_c", lr: 0.1, l2: 0.1, epochs: 500 },
  { id: "lr_d", lr: 0.5, l2: 0.1, epochs: 500 },
  { id: "lr_e", lr: 0.1, l2: 0.01, epochs: 1000 },
  { id: "lr_f", lr: 0.5, l2: 0.01, epochs: 1000 },
];

export interface LRModel {
  hyperId: string;
  means: number[];
  stds: number[];
  weights: number[];
  bias: number;
}

export function toArray(fv: FeatureVector): number[] {
  return [fv.r, fv.f, fv.m, fv.e, fv.n, fv.c];
}

function sigmoid(z: number): number {
  return z >= 0
    ? 1 / (1 + Math.exp(-z))
    : Math.exp(z) / (1 + Math.exp(z));
}

/** Fit on train-cutoff features with train-window binary labels. */
export function trainLogistic(
  feats: FeatureVector[],
  labels: Map<number, number>,
  hp: LRHyperparams,
): { weights: number[]; bias: number; means: number[]; stds: number[] } {
  const d = 6;
  const X = feats.map(toArray);
  const y = feats.map((f) => labels.get(f.constituentId) ?? 0);
  const n = X.length;
  const means = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j]!, 0) / n);
  const stds = Array.from({ length: d }, (_, j) => {
    const v = X.reduce((s, r) => s + (r[j]! - means[j]!) ** 2, 0) / n;
    return Math.sqrt(v) || 1; // constant feature -> unit scale, zero-centered
  });
  const Z = X.map((r) => r.map((v, j) => (v - means[j]!) / stds[j]!));
  let w = new Array<number>(d).fill(0);
  let b = 0;
  for (let ep = 0; ep < hp.epochs; ep++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i]!.reduce((s, v, j) => s + v * w[j]!, 0) + b;
      const err = sigmoid(z) - y[i]!;
      for (let j = 0; j < d; j++) gw[j]! += err * Z[i]![j]!;
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j]! -= hp.lr * (gw[j]! / n + hp.l2 * w[j]!);
    b -= hp.lr * (gb / n);
  }
  return { weights: w, bias: b, means, stds };
}

export function predictProb(model: LRModel, fv: FeatureVector): number {
  const x = toArray(fv);
  const z =
    x.reduce((s, v, j) => s + ((v - model.means[j]!) / model.stds[j]!) * model.weights[j]!, 0) +
    model.bias;
  return sigmoid(z);
}

export function lrRanker(model: LRModel, hyperId: string) {
  return {
    id: `trained_lr_${hyperId}`,
    family: "trained" as const,
    description: `L2 logistic regression on [r,f,m,e,n,c] trained at ${"TRAIN cutoff"} (hyperparams ${hyperId})`,
    score: (fv: FeatureVector) => predictProb(model, fv),
  };
}

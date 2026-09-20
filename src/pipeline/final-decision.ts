import {
  evaluateRubricForCandidate,
  PIPELINE_FIELDS,
  type CandidateRubricEvaluation,
  type DynamicJevClient,
  type DynamicRubric,
  type PipelineField,
} from "./jev-evaluator.js";

export const FINAL_ACTIONS = ["thank_you", "event_invite", "reunion_mailer", "ask"] as const;
export type FinalAction = (typeof FINAL_ACTIONS)[number];

export const FINAL_ACTION_DESCRIPTIONS: Record<FinalAction, string> = {
  thank_you: "Send a thank-you or stewardship message without making another ask.",
  event_invite: "Invite the constituent to a relevant event without making a direct ask.",
  reunion_mailer: "Send a reunion-related invitation or mailer without a direct ask.",
  ask: "Make a direct fundraising ask, only when deterministic permissions allow it.",
};

export interface FinalDecisionCandidate {
  constituentId: number;
  rank: number;
  disposition: CandidateRubricEvaluation["disposition"];
  fields: Record<string, unknown>;
  evidenceRefs?: Partial<Record<PipelineField, string[]>>;
  /** Computed by deterministic eligibility and channel rules, never by Jev. */
  eligibleForContact: boolean;
  eligibleForSolicitation: boolean;
  permittedActions: FinalAction[];
}

export interface FinalActionDecision {
  constituentId: number;
  rank: number;
  status: "decided" | "blocked" | "unknown";
  requestedAction: FinalAction | null;
  action: FinalAction | null;
  overridden: boolean;
  rawAnswer: Record<string, unknown> | null;
  evidenceRefs: string[];
  cacheHit: boolean;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface FinalDecisionQuestion {
  rubric: DynamicRubric;
  criterionFields: PipelineField[];
}

/** Build the final Choice rubric. Its only labels are the four supported actions. */
export function buildFinalDecisionQuestion(
  fields: PipelineField[],
  question = "Which single outreach action is appropriate?",
  options: Record<FinalAction, string> = FINAL_ACTION_DESCRIPTIONS,
): FinalDecisionQuestion {
  if (fields.length === 0) throw new Error("Final decision needs at least one scoped field");
  const allowlist = new Set<string>(PIPELINE_FIELDS);
  for (const field of fields) if (!allowlist.has(field)) throw new Error(`Unsupported final-decision field: ${String(field)}`);
  return {
    rubric: {
      id: "final-outreach-decision",
      version: "1",
      gates: [],
      scores: [],
      bonuses: [],
      tags: [{ id: "final_action", question, options: { ...options }, fields: [...fields] }],
    },
    criterionFields: [...fields],
  };
}

/** Run the separate action Choice for at most the final twenty eligible ranks. */
export async function evaluateFinalTopTwentyActions(args: {
  rankedCandidates: FinalDecisionCandidate[];
  fields: PipelineField[];
  asOf: string;
  datasetVersion?: string;
  evidenceVersion?: string;
  model?: string;
  client?: DynamicJevClient;
  cache?: QuestionAnswerCache;
  limit?: number;
  question?: string;
  actionOptions?: Record<FinalAction, string>;
}): Promise<FinalActionDecision[]> {
  const limit = Math.max(0, Math.min(20, Math.floor(args.limit ?? 20)));
  const question = buildFinalDecisionQuestion(args.fields, args.question, args.actionOptions);
  const selected = [...args.rankedCandidates]
    .filter((candidate) => candidate.disposition === "eligible")
    .sort((a, b) => a.rank - b.rank || a.constituentId - b.constituentId)
    .slice(0, limit);
  const decisions: FinalActionDecision[] = [];

  for (const candidate of selected) {
    if (!candidate.eligibleForContact) {
      decisions.push({
        constituentId: candidate.constituentId, rank: candidate.rank, status: "blocked",
        requestedAction: null, action: null, overridden: false, rawAnswer: null,
        evidenceRefs: [], cacheHit: false, model: null, inputTokens: 0, outputTokens: 0, latencyMs: 0,
      });
      continue;
    }

    const evaluation = await evaluateRubricForCandidate({
      constituentId: candidate.constituentId,
      fields: candidate.fields,
      evidenceRefs: candidate.evidenceRefs,
      rubric: question.rubric,
      asOf: args.asOf,
      datasetVersion: args.datasetVersion,
      evidenceVersion: args.evidenceVersion,
      model: args.model,
      client: args.client,
      cache: args.cache,
    });
    const choice = evaluation.tags.final_action;
    const rawAnswer = choice?.rawAnswer ?? null;
    const rawChoice = rawAnswer?.choice;
    const requestedAction = isFinalAction(rawChoice) ? rawChoice : null;
    if (requestedAction === null) {
      decisions.push({
        constituentId: candidate.constituentId, rank: candidate.rank, status: "unknown",
        requestedAction: null, action: null, overridden: false, rawAnswer,
        evidenceRefs: choice?.evidenceRefs ?? [], cacheHit: choice?.cacheHit ?? false,
        model: choice?.model ?? null, inputTokens: choice?.inputTokens ?? 0,
        outputTokens: choice?.outputTokens ?? 0, latencyMs: choice?.latencyMs ?? 0,
      });
      continue;
    }

    const permitted = new Set(candidate.permittedActions);
    const actionAllowed = candidate.eligibleForContact && permitted.has(requestedAction) &&
      (requestedAction !== "ask" || candidate.eligibleForSolicitation);
    const fallbackAction = actionAllowed ? null : candidate.permittedActions.find((action) =>
      action !== "ask" || candidate.eligibleForSolicitation,
    ) ?? null;
    decisions.push({
      constituentId: candidate.constituentId, rank: candidate.rank,
      status: actionAllowed || fallbackAction ? "decided" : "blocked", requestedAction,
      action: actionAllowed ? requestedAction : fallbackAction, overridden: !actionAllowed, rawAnswer,
      evidenceRefs: choice?.evidenceRefs ?? [], cacheHit: choice?.cacheHit ?? false,
      model: choice?.model ?? null, inputTokens: choice?.inputTokens ?? 0,
      outputTokens: choice?.outputTokens ?? 0, latencyMs: choice?.latencyMs ?? 0,
    });
  }
  return decisions;
}

function isFinalAction(value: unknown): value is FinalAction {
  return typeof value === "string" && (FINAL_ACTIONS as readonly string[]).includes(value);
}
import type { QuestionAnswerCache } from "./question-cache.js";

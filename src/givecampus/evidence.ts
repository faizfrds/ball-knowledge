/**
 * Rich evidence collection: every displayed reason links to row ids.
 * Missing-data panel lists gaps explicitly — never hidden, never silently dropped.
 */

export interface EvidenceItem {
  table: string;
  id: number | string;
  field?: string;
  value?: string;
  note?: string;
}

export interface EvidenceCollection {
  asOf: string;
  items: EvidenceItem[];
  missing: string[];
  refs: string[];
}

export function collectEvidence(args: {
  asOf: string;
  constituentId: number;
  giftIds?: number[];
  lastGift?: { id: number; gift_date: string; amount: number } | null;
  interactionIds?: number[];
  attendanceIds?: number[];
  eventIds?: number[];
  careerIds?: number[];
  degreeInfo?: string | null;
  activityNames?: string[];
  fundNote?: string | null;
  gaps?: string[];
}): EvidenceCollection {
  const items: EvidenceItem[] = [{ table: "constituents", id: args.constituentId }];
  for (const id of args.giftIds ?? []) items.push({ table: "gifts", id });
  if (args.lastGift) {
    items.push({
      table: "gifts",
      id: args.lastGift.id,
      field: "gift_date+amount",
      value: `${args.lastGift.gift_date} $${args.lastGift.amount}`,
    });
  }
  for (const id of args.interactionIds ?? []) items.push({ table: "interactions", id });
  for (const id of args.attendanceIds ?? []) items.push({ table: "event_attendance", id });
  for (const id of args.eventIds ?? []) items.push({ table: "events", id });
  for (const id of args.careerIds ?? []) items.push({ table: "career_history", id });
  if (args.degreeInfo) {
    items.push({ table: "degrees", id: args.constituentId, field: "class_year", value: args.degreeInfo });
  }
  for (const name of args.activityNames ?? []) {
    items.push({ table: "activities", id: args.constituentId, field: "activity_name", value: name });
  }
  if (args.fundNote) {
    items.push({ table: "gift_allocations", id: args.constituentId, field: "designation", value: args.fundNote });
  }
  const missing = [...(args.gaps ?? [])];
  return {
    asOf: args.asOf,
    items,
    missing,
    refs: items.map((i) => `${i.table}:${i.id}`),
  };
}

import type { AuthorKind } from '../contracts/docs.js';
import type { Effect } from './types.js';
import { ALWAYS_CONFIRM } from './types.js';

/**
 * Who approved something. In the original assistant 90% of "approved" work items were approved by a planning bot
 * and flowed on exactly like the owner's approval. Here the kind is a fixed field and code decides what it may pass.
 */
export type ApproverKind = AuthorKind;

export interface ApprovalRecord {
  approverKind: ApproverKind;
  /** "owner", "lead:dev", "policy:auto-write". */
  approverId: string;
  effects: readonly Effect[];
  /** ISO 8601. */
  at: string;
  note?: string;
}

/** send, pay and delete (and release, which is a send) pass only with the owner's approval. */
export function approvalAllows(effects: readonly Effect[], kind: ApproverKind): boolean {
  if (effects.some((effect) => ALWAYS_CONFIRM.includes(effect))) return kind === 'user';
  return true;
}

/** Text from an agent or a tool result never counts as approval, however it is phrased. */
export function isOwnerApproval(record: ApprovalRecord): boolean {
  return record.approverKind === 'user' && record.approverId === 'owner';
}

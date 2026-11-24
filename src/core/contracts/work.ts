/** How much work a work-taking plugin (company mode) has open, for the improvement loop and health checks. */
export interface BacklogSnapshot {
  /** queued + running + review + waiting for the owner. */
  open: number;
  /** Open items not touched for longer than the age limit. */
  stale: number;
  createdInWeek: number;
  doneInWeek: number;
  /** Closed automatically for age in the last 7 days. */
  autoClosedInWeek: number;
  /** The current cap on open items. */
  openLimit: number;
}

/** Capability "work.backlog". */
export interface BacklogReader {
  snapshot(now: Date): Promise<BacklogSnapshot>;
}

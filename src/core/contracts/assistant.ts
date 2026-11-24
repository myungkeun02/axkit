/**
 * Capability "assistant.runner": one assistant turn started by the server itself (a routine, a follow-up), as if the
 * owner had asked. It goes through the same tools, confirmation cards and kill switch as a turn the owner typed.
 */
export interface RunnerInput {
  /** What the owner asked, in their own words. */
  text: string;
  /** Run as this bot (its team, when it is a team lead); the main assistant when missing. */
  bot?: string;
  /** Keeps this source's turns in their own conversation memory ("routine:<id>"). */
  source: string;
}

export interface RunnerResult {
  text: string;
  /** False when the turn could not really run (no model, over budget, no usable plan). */
  ok: boolean;
  /**
   * Why a turn did not run, when `ok` is false. `over_budget`, `no_model` and `provider_down` are outages of the AI
   * itself, not of the request: callers that count failures (routines) leave those out.
   */
  reason?: RunnerFailure;
  /** How the turn ended: `partial` ran some tools and then stopped (ok is false; the text says what was done). */
  status?: TurnState;
  bot?: { id: string; name: string };
}

export type RunnerFailure = 'over_budget' | 'no_model' | 'provider_down' | 'invalid_plan';

/** completed: the turn answered; partial: tools ran, then it stopped; failed: nothing useful ran. */
export type TurnState = 'completed' | 'partial' | 'failed';

/** How one assistant turn ended, told by the turn itself instead of guessed from its reply text. */
export type TurnStatus = { state: 'completed' } | { state: 'partial' | 'failed'; reason: RunnerFailure };

export interface AssistantRunner {
  run(input: RunnerInput): Promise<RunnerResult>;
}

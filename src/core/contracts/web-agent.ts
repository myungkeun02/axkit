/**
 * Capability "web.agent": a browser agent that works in the owner's own signed-in browser (Aside CLI), so the
 * assistant can use any web tool the owner can (an internal admin page, a shop, a booking site) without a per-site
 * integration. `look` never changes anything; `do` runs only after the owner approved that exact task on a card, and
 * still stops before the final payment step.
 */
export type WebMode = 'look' | 'do' | 'pay';

/** What waits at the final payment step, as the agent read it off the page. */
export interface WebCart {
  items: string;
  /** In won. */
  total: number;
  /** The saved payment method the site shows ("토스페이", "신한카드 ****1234"). */
  method?: string;
}

export interface WebRunInput {
  task: string;
  mode: WebMode;
  /** A site the task is about ("admin.example.co.kr"), opened first when given. */
  site?: string;
  timeoutMinutes?: number;
  /** mode "pay" only: the cart the owner approved; the agent stops if the page shows anything else. */
  payment?: WebCart;
}

export interface WebRunResult {
  ok: boolean;
  /** What the agent reports, as untrusted page-derived text. */
  answer: string;
  session?: string;
  /** Why it stopped short, when it did. */
  stopped?: 'login' | 'payment' | 'changed' | 'card' | 'timeout' | 'error';
  /** At `stopped: "payment"`: the cart and total waiting for the owner's approval. */
  cart?: WebCart;
}

export interface WebAgent {
  readonly label: string;
  run(input: WebRunInput, signal?: AbortSignal): Promise<WebRunResult>;
}

/** Capability "assistant.context": other skills add a short section to the assistant's prompt for each message. */
export interface AssistantContext {
  addSection(id: string, section: (messageText: string) => Promise<string | undefined>): void;
}

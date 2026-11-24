import { SOURCE_ROUTES, pairResponseSchema } from '../../core/remote/protocol.js';
import type { PostJson } from './http.js';
import { RemoteSourceError, nodePostJson } from './http.js';

export interface PairResult {
  token: string;
  /** The other Mac's computer name. */
  host: string;
}

/**
 * Trades the short code `ax-kit source pair` printed on the other Mac for a long token. The code works once and
 * only for ten minutes; the token is what this Mac keeps (in the Keychain).
 */
export async function exchangePairingCode(url: string, code: string, name: string, post: PostJson = nodePostJson): Promise<PairResult> {
  const raw = await post(url, SOURCE_ROUTES.pair, { code: code.trim().toUpperCase(), name }, { timeoutMs: 15_000, maxBytes: 10_000 });
  const parsed = pairResponseSchema.safeParse(raw);
  if (!parsed.success) throw new RemoteSourceError('bad_response', 'The other Mac answered pairing in an unexpected shape.');
  return parsed.data;
}

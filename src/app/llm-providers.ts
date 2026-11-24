import type { Config } from '../core/config/schema.js';
import type { Logger } from '../core/log/types.js';
import type { LlmProvider } from '../core/llm/types.js';
import type { SecretStore } from '../core/secrets/types.js';
import { createAnthropicProvider } from '../core/llm/providers/anthropic.js';
import { createOpenAiCompatibleProvider } from '../core/llm/providers/openai-compatible.js';
import { createCliProvider } from '../core/llm/providers/cli.js';
import { nodeCliRunner } from '../core/llm/providers/node-runner.js';

type ProviderConfig = Config['llm']['providers'][number];

type KeyResult = { ok: true; key: string | undefined } | { ok: false };

async function resolveKey(provider: ProviderConfig, secrets: SecretStore, log: Logger): Promise<KeyResult> {
  if (provider.kind === 'claude-cli' || provider.kind === 'codex-cli') return { ok: true, key: undefined };
  if (provider.apiKeySecret === undefined) {
    if (provider.kind === 'anthropic') {
      log.warn('skipping llm provider: anthropic needs an api key secret', { provider: provider.id });
      return { ok: false };
    }
    return { ok: true, key: undefined };
  }

  let key: string | undefined;
  try {
    key = await secrets.get(provider.apiKeySecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('skipping llm provider: cannot read key secret', {
      provider: provider.id,
      secret: provider.apiKeySecret,
      error: message,
    });
    return { ok: false };
  }
  if (key === undefined) {
    log.warn('skipping llm provider: key secret is missing', {
      provider: provider.id,
      secret: provider.apiKeySecret,
    });
    return { ok: false };
  }
  return { ok: true, key };
}

export function makeProvider(provider: ProviderConfig, key: string | undefined): LlmProvider {
  const prices = { priceInPerMTok: provider.priceIn, priceOutPerMTok: provider.priceOut };
  if (provider.kind === 'claude-cli' || provider.kind === 'codex-cli') {
    return createCliProvider({
      id: provider.id,
      kind: provider.kind,
      run: nodeCliRunner,
      ...(provider.command !== undefined ? { command: provider.command } : {}),
    });
  }
  if (provider.kind === 'anthropic') {
    return createAnthropicProvider({
      id: provider.id,
      apiKey: key ?? '',
      ...prices,
      ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    });
  }
  return createOpenAiCompatibleProvider({
    id: provider.id,
    baseUrl: provider.baseUrl ?? 'https://api.openai.com/v1',
    ...prices,
    ...(key !== undefined ? { apiKey: key } : {}),
  });
}

/** Builds one provider per configured entry, skipping entries whose key cannot be read. */
export async function createProviders(
  config: Config,
  secrets: SecretStore,
  log: Logger,
): Promise<LlmProvider[]> {
  const providers: LlmProvider[] = [];
  for (const provider of config.llm.providers) {
    const key = await resolveKey(provider, secrets, log);
    if (key.ok) providers.push(makeProvider(provider, key.key));
  }
  return providers;
}

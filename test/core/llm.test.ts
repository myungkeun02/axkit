import { describe, expect, it, vi } from 'vitest';
import { MemoryUsageLedger } from '../../src/core/llm/ledger.js';
import { ProviderCircuit } from '../../src/core/llm/circuit.js';
import { RoutingLlmGateway } from '../../src/core/llm/gateway.js';
import type { LlmProvider, LlmRequest, LlmResponse, LlmRoute } from '../../src/core/llm/types.js';
import { createOpenAiCompatibleProvider } from '../../src/core/llm/providers/openai-compatible.js';
import { createAnthropicProvider } from '../../src/core/llm/providers/anthropic.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { FakeClock } from './helpers.js';

function llmResponse(providerId: string, model: string, costUsd = 0.01): LlmResponse {
  return { text: 'ok', providerId, model, usage: { inputTokens: 10, outputTokens: 5, costUsd } };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: 'test',
    tier: 'standard',
    sensitivity: 'public',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function provider(id: string, impl?: () => Promise<LlmResponse>): LlmProvider {
  return {
    id,
    complete: vi.fn(async (model: string) => impl === undefined ? llmResponse(id, model) : impl()),
  };
}

function gateway(
  providers: readonly LlmProvider[],
  routes: readonly LlmRoute[],
  opts: {
    ledger?: MemoryUsageLedger;
    dailyUsd?: number;
    monthlyUsd?: number;
    clock?: FakeClock;
    circuit?: ProviderCircuit;
  } = {},
): { gateway: RoutingLlmGateway; ledger: MemoryUsageLedger; clock: FakeClock } {
  const ledger = opts.ledger ?? new MemoryUsageLedger();
  const clock = opts.clock ?? new FakeClock(new Date('2026-03-08T12:00:00Z'));
  return {
    gateway: new RoutingLlmGateway({
      providers,
      routes,
      budget: { dailyUsd: opts.dailyUsd ?? 1, monthlyUsd: opts.monthlyUsd ?? 20 },
      ledger,
      timeZone: 'Asia/Seoul',
      log: silentLogger,
      clock,
      ...(opts.circuit !== undefined ? { circuit: opts.circuit } : {}),
      retry: { sleep: async () => undefined },
    }),
    ledger,
    clock,
  };
}

describe('RoutingLlmGateway', () => {
  it('routes by tier and sensitivity in config order', async () => {
    const publicProvider = provider('public');
    const sensitiveProvider = provider('sensitive');
    const routes: LlmRoute[] = [
      { providerId: 'public', model: 'p', tiers: ['standard'], maxSensitivity: 'public' },
      { providerId: 'sensitive', model: 's', tiers: ['standard'], maxSensitivity: 'sensitive' },
    ];
    const { gateway: router } = gateway([publicProvider, sensitiveProvider], routes);

    const publicResult = await router.complete(request({ sensitivity: 'public' }));
    expect(publicResult.providerId).toBe('public');

    const sensitiveResult = await router.complete(request({ sensitivity: 'sensitive' }));
    expect(sensitiveResult.providerId).toBe('sensitive');

    const maskedResult = await router.complete(request({ sensitivity: 'masked' }));
    expect(maskedResult.providerId).toBe('sensitive');
  });

  it('throws no_route when no route matches', async () => {
    const { gateway: router } = gateway([provider('p')], [
      { providerId: 'p', model: 'm', tiers: ['fast'], maxSensitivity: 'sensitive' },
    ]);
    await expect(router.complete(request({ tier: 'deep' }))).rejects.toMatchObject({ code: 'no_route' });
  });

  it('falls back to the next provider', async () => {
    const first = provider('first', async () => {
      throw new Error('down');
    });
    const second = provider('second');
    const routes: LlmRoute[] = [
      { providerId: 'first', model: 'm1', tiers: ['standard'], maxSensitivity: 'sensitive' },
      { providerId: 'second', model: 'm2', tiers: ['standard'], maxSensitivity: 'sensitive' },
    ];
    const { gateway: router, ledger } = gateway([first, second], routes);

    const result = await router.complete(request());
    expect(result.providerId).toBe('second');
    expect(await ledger.spentUsd(new Date(0))).toBeCloseTo(0.01);
  });

  it('throws provider_failed when all providers fail', async () => {
    const fail = provider('fail', async () => {
      throw new Error('x');
    });
    const { gateway: router } = gateway([fail], [
      { providerId: 'fail', model: 'm', tiers: ['standard'], maxSensitivity: 'sensitive' },
    ]);
    await expect(router.complete(request())).rejects.toMatchObject({ code: 'provider_failed' });
  });

  it('enforces the daily budget', async () => {
    const p = provider('p');
    const { gateway: router, ledger, clock } = gateway([p], [
      { providerId: 'p', model: 'm', tiers: ['standard'], maxSensitivity: 'sensitive' },
    ], { dailyUsd: 1 });
    await ledger.record({
      at: clock.now(),
      purpose: 'previous',
      providerId: 'p',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 },
    });

    await expect(router.complete(request())).rejects.toMatchObject({ code: 'over_budget' });
  });

  it('enforces the monthly budget', async () => {
    const p = provider('p');
    const { gateway: router, ledger, clock } = gateway([p], [
      { providerId: 'p', model: 'm', tiers: ['standard'], maxSensitivity: 'sensitive' },
    ], { dailyUsd: 100, monthlyUsd: 5 });
    await ledger.record({
      at: new Date('2026-03-02T00:00:00Z'),
      purpose: 'previous',
      providerId: 'p',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 5 },
    });

    await expect(router.complete(request())).rejects.toMatchObject({ code: 'over_budget' });
    expect(clock.now().toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });

  it('throws no_route when a route points at a missing provider', async () => {
    const { gateway: router } = gateway([], [
      { providerId: 'ghost', model: 'm', tiers: ['standard'], maxSensitivity: 'sensitive' },
    ]);
    await expect(router.complete(request())).rejects.toMatchObject({ code: 'no_route' });
  });
});

describe('RoutingLlmGateway circuit breaker', () => {
  const routes: LlmRoute[] = [
    { providerId: 'first', model: 'm1', tiers: ['standard'], maxSensitivity: 'sensitive' },
    { providerId: 'second', model: 'm2', tiers: ['standard'], maxSensitivity: 'sensitive' },
  ];

  it('skips an open provider and falls back to the next one', async () => {
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const circuit = new ProviderCircuit({ clock });
    const first = provider('first', async () => {
      throw new Error('down');
    });
    const second = provider('second');
    const { gateway: router } = gateway([first, second], routes, { clock, circuit });

    for (let i = 0; i < 3; i += 1) await router.complete(request());
    expect(circuit.stateOf('first')).toBe('open');
    expect(first.complete).toHaveBeenCalledTimes(3);

    const result = await router.complete(request());
    expect(result.providerId).toBe('second');
    expect(first.complete).toHaveBeenCalledTimes(3);
  });

  it('throws a paused error with the retry time when every candidate is open', async () => {
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const circuit = new ProviderCircuit({ clock });
    const fail = (id: string): LlmProvider =>
      provider(id, async () => {
        throw new Error('down');
      });
    const first = fail('first');
    const second = fail('second');
    const { gateway: router } = gateway([first, second], routes, { clock, circuit });

    for (let i = 0; i < 3; i += 1) {
      await expect(router.complete(request())).rejects.toMatchObject({ code: 'provider_failed' });
    }
    expect(circuit.stateOf('first')).toBe('open');
    expect(circuit.stateOf('second')).toBe('open');

    const error = await router.complete(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'provider_failed' });
    expect((error as Error).message).toBe(
      'All providers are paused after repeated failures; retrying after 2026-03-08T12:05:00.000Z',
    );
    expect(first.complete).toHaveBeenCalledTimes(3);
    expect(second.complete).toHaveBeenCalledTimes(3);
  });

  it('does not count caller aborts as provider failures', async () => {
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const circuit = new ProviderCircuit({ clock });
    const controller = new AbortController();
    const aborted = provider('aborted', async () => {
      controller.abort();
      throw new Error('aborted by caller');
    });
    const { gateway: router } = gateway(
      [aborted],
      [{ providerId: 'aborted', model: 'm', tiers: ['standard'], maxSensitivity: 'sensitive' }],
      { clock, circuit },
    );

    for (let i = 0; i < 4; i += 1) {
      await expect(router.complete(request({ signal: controller.signal }))).rejects.toThrow(
        'aborted by caller',
      );
    }
    expect(circuit.stateOf('aborted')).toBe('closed');
    expect(aborted.complete).toHaveBeenCalledTimes(4);
  });

  it('falls back on content failures without counting them against the provider', async () => {
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const circuit = new ProviderCircuit({ clock });
    const messages = [
      'Claude CLI returned invalid JSON: x',
      'Malformed response from LLM provider',
      'LLM request failed with status 400',
      'Codex returned an empty answer: ',
    ];
    let call = 0;
    const first = provider('first', async () => {
      throw new Error(messages[call++ % messages.length]);
    });
    const second = provider('second');
    const { gateway: router } = gateway([first, second], routes, { clock, circuit });

    for (let i = 0; i < 8; i += 1) {
      const result = await router.complete(request());
      expect(result.providerId).toBe('second');
    }
    expect(circuit.stateOf('first')).toBe('closed');
    expect(first.complete).toHaveBeenCalledTimes(8);
  });

  it('still counts auth, throttle and server errors as provider failures', async () => {
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    for (const message of ['LLM request failed with status 401', 'LLM request failed with status 429', 'LLM request failed with status 503']) {
      const circuit = new ProviderCircuit({ clock });
      const first = provider('first', async () => {
        throw new Error(message);
      });
      const { gateway: router } = gateway([first, provider('second')], routes, { clock, circuit });
      for (let i = 0; i < 3; i += 1) await router.complete(request());
      expect(circuit.stateOf('first')).toBe('open');
    }
  });

  it('retries an open provider after the cooldown and closes it on success', async () => {
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const circuit = new ProviderCircuit({ clock });
    let failing = true;
    const p = provider('p', async () => {
      if (failing) throw new Error('down');
      return llmResponse('p', 'm');
    });
    const { gateway: router } = gateway(
      [p],
      [{ providerId: 'p', model: 'm', tiers: ['standard'], maxSensitivity: 'sensitive' }],
      { clock, circuit },
    );

    for (let i = 0; i < 3; i += 1) {
      await expect(router.complete(request())).rejects.toMatchObject({ code: 'provider_failed' });
    }
    expect(circuit.stateOf('p')).toBe('open');

    failing = false;
    await clock.advance(5 * 60_000);
    const result = await router.complete(request());
    expect(result.providerId).toBe('p');
    expect(circuit.stateOf('p')).toBe('closed');
    expect(p.complete).toHaveBeenCalledTimes(4);
  });
});

describe('MemoryUsageLedger', () => {
  it('sums usage since the given instant', async () => {
    const ledger = new MemoryUsageLedger();
    await ledger.record({
      at: new Date('2026-01-01T00:00:00Z'),
      purpose: 'a',
      providerId: 'p',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 },
    });
    await ledger.record({
      at: new Date('2026-01-02T00:00:00Z'),
      purpose: 'b',
      providerId: 'p',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.25 },
    });

    expect(await ledger.spentUsd(new Date('2026-01-02T00:00:00Z'))).toBe(0.25);
    expect(await ledger.spentUsd(new Date(0))).toBe(0.75);
  });
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenAiCompatibleProvider', () => {
  it('sends an OpenAI-compatible request and parses the response', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        choices: [{ message: { content: '{"answer":42}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
    }) as unknown as typeof fetch;

    const providerImpl = createOpenAiCompatibleProvider({
      id: 'openai',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'key-123',
      priceInPerMTok: 1,
      priceOutPerMTok: 2,
      fetch: fetchImpl,
    });

    const result = await providerImpl.complete('gpt-x', request({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
      jsonSchema: { type: 'object' },
      maxOutputTokens: 100,
    }));

    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer key-123');
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens: number;
      response_format: unknown;
    };
    expect(body.model).toBe('gpt-x');
    expect(body.max_tokens).toBe(100);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]?.content).toContain('Be brief.');
    expect(body.messages[0]?.content).toContain('"type":"object"');

    expect(result.text).toBe('{"answer":42}');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.costUsd).toBeCloseTo(100 / 1e6 + 100 / 1e6);
  });

  it('does not require or send an api key', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return jsonResponse({ choices: [{ message: { content: 'x' } }] });
    }) as unknown as typeof fetch;
    const providerImpl = createOpenAiCompatibleProvider({ id: 'local', baseUrl: 'http://localhost:1234', fetch: fetchImpl });
    await providerImpl.complete('m', request());
    expect(headers.authorization).toBeUndefined();
  });

  it('reports only the status on failure', async () => {
    const fetchImpl = (async () => new Response('sensitive upstream detail', { status: 500 })) as unknown as typeof fetch;
    const providerImpl = createOpenAiCompatibleProvider({ id: 'openai', baseUrl: 'https://x.test', fetch: fetchImpl });
    await expect(providerImpl.complete('m', request())).rejects.toThrow(/status 500/);
    await expect(providerImpl.complete('m', request())).rejects.not.toThrow(/upstream detail/);
  });
});

describe('createAnthropicProvider', () => {
  it('joins system messages, sends headers and parses text blocks', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'tool_use', id: 'x' },
          { type: 'text', text: 'world' },
        ],
        usage: { input_tokens: 20, output_tokens: 7 },
      });
    }) as unknown as typeof fetch;

    const providerImpl = createAnthropicProvider({
      id: 'anthropic',
      apiKey: 'sk-ant',
      priceInPerMTok: 3,
      priceOutPerMTok: 15,
      fetch: fetchImpl,
    });

    const result = await providerImpl.complete('claude-haiku-5-5', request({
      messages: [
        { role: 'system', content: 'one' },
        { role: 'system', content: 'two' },
        { role: 'user', content: 'hi' },
      ],
    }));

    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      system: string;
      max_tokens: number;
      messages: { role: string; content: string }[];
    };
    expect(body.system).toBe('one\n\ntwo');
    // a Claude 5 model thinks first: room for it on top, and effort by tier
    expect(body.max_tokens).toBe(1024 + 4096);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('Hello world');
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.usage.costUsd).toBeCloseTo((20 / 1e6) * 3 + (7 / 1e6) * 15);
  });

  it('passes max output tokens and the JSON schema hint', async () => {
    let body: { max_tokens: number; system: string } | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { max_tokens: number; system: string };
      return jsonResponse({ content: [{ type: 'text', text: '{}' }], usage: {} });
    }) as unknown as typeof fetch;
    const providerImpl = createAnthropicProvider({ id: 'a', apiKey: 'k', baseUrl: 'https://proxy.test/', fetch: fetchImpl });

    await providerImpl.complete('m', request({
      messages: [{ role: 'user', content: 'hi' }],
      jsonSchema: { type: 'object' },
      maxOutputTokens: 256,
    }));

    expect(body?.max_tokens).toBe(256);
    expect(body?.system).toContain('"type":"object"');
  });

  it('reports only the status on failure', async () => {
    const fetchImpl = (async () => new Response('secret detail', { status: 401 })) as unknown as typeof fetch;
    const providerImpl = createAnthropicProvider({ id: 'a', apiKey: 'k', fetch: fetchImpl });
    await expect(providerImpl.complete('m', request())).rejects.toThrow(/status 401/);
  });
});

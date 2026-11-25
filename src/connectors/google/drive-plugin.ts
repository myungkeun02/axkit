import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import { DEFAULT_FILE_RULES } from '../../core/files/filter.js';
import type { FileRules } from '../../core/files/filter.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { GoogleDriveFiles } from './drive.js';
import { GoogleDriveWriter } from './drive-write.js';
import { googleRequest, sleepUnlessAborted, withScopedSignal } from './http.js';
import type { GoogleRequestFn } from './http.js';
import { GoogleTokenSource } from './token.js';
import { GOOGLE_SECRETS, accountLabel, readAccountList, refreshSecretFor } from './accounts.js';

export interface GoogleDriveConnectorOptions {
  /** Tests inject a fake; production uses global fetch. */
  fetch?: typeof fetch;
  /** Tests inject a fake; production waits real milliseconds. */
  sleep?: (ms: number) => Promise<void>;
}

interface DriveRequests {
  request: GoogleRequestFn;
  requestText: (url: string, init?: RequestInit) => Promise<string>;
  requestBytes: (url: string) => Promise<Uint8Array>;
}

const MAX_ALLOWED_BYTES = 5_000_000;
const RETRY_DELAY_MS = 1_000;

const configSchema = z.object({
  folderIds: z.array(z.string().trim().min(1)).max(50).default([]),
  maxBytes: z.number().int().min(1).max(MAX_ALLOWED_BYTES).default(DEFAULT_FILE_RULES.maxBytes),
  exclude: z.array(z.string()).max(100).default([]),
});

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Text bodies (export, alt=media) cannot go through the JSON helper in http.ts. */
async function bodyRequest(
  deps: { fetch: typeof fetch; tokens: GoogleTokenSource; sleep: (ms: number) => Promise<void> },
  url: string,
  given: RequestInit = {},
): Promise<Response> {
  const init = withScopedSignal(given);
  const signal = init.signal ?? undefined;
  let refreshed = false;
  let slept = false;
  for (;;) {
    const token = await deps.tokens.accessToken(signal);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await deps.fetch(url, { ...init, headers });
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      deps.tokens.invalidate();
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && !slept) {
      slept = true;
      await sleepUnlessAborted(deps.sleep, RETRY_DELAY_MS, signal);
      continue;
    }
    if (!response.ok) throw new Error(`Google Drive request failed (HTTP ${response.status})`);
    return response;
  }
}

function requestsFor(ctx: PluginContext, opts: GoogleDriveConnectorOptions, key = ''): DriveRequests {
  const fetchImpl = opts.fetch ?? fetch;
  const tokens = new GoogleTokenSource({ secrets: ctx.secrets, clock: ctx.clock, fetch: fetchImpl, refreshSecret: refreshSecretFor(key) });
  const sleep = opts.sleep ?? defaultSleep;
  return {
    request: <T>(url: string, init?: RequestInit): Promise<T> =>
      googleRequest<T>({ fetch: fetchImpl, tokens, sleep }, url, init),
    requestText: async (url, init) => await (await bodyRequest({ fetch: fetchImpl, tokens, sleep }, url, init)).text(),
    requestBytes: async (url) => new Uint8Array(await (await bodyRequest({ fetch: fetchImpl, tokens, sleep }, url)).arrayBuffer()),
  };
}

function rulesOf(ctx: PluginContext): { rules: FileRules; folderIds: string[] } {
  const parsed = configSchema.safeParse(ctx.config);
  if (!parsed.success) {
    ctx.log.warn('drive: invalid config, nothing will be listed', { issues: parsed.error.issues.length });
    return { rules: DEFAULT_FILE_RULES, folderIds: [] };
  }
  return {
    rules: { extensions: [...DEFAULT_FILE_RULES.extensions], maxBytes: parsed.data.maxBytes, exclude: parsed.data.exclude },
    folderIds: parsed.data.folderIds,
  };
}

/** Connector for the owner's Google Drive, read-only over the folders in config. */
export function googleDriveConnector(opts: GoogleDriveConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.google-drive',
      kind: 'connector',
      title: 'Google Drive',
      secrets: [...GOOGLE_SECRETS],
    },
    setup(ctx) {
      const { rules, folderIds } = rulesOf(ctx);
      if (folderIds.length === 0) ctx.log.warn('drive: no folders configured; nothing will be listed');
      const requests = requestsFor(ctx, opts);
      ctx.provide(
        Contracts.filesDrive,
        new GoogleDriveFiles({
          request: requests.request,
          requestText: requests.requestText,
          requestBytes: requests.requestBytes,
          rules,
          folderIds,
          log: ctx.log,
        }),
      );
      ctx.provide(Contracts.driveWrite, new GoogleDriveWriter(requests.request));
      // another connected account's Drive: its own files (no folders are set for it), as a source of its own
      ctx.bus.on('app.started', () => {
        const registry = ctx.tryUse(Contracts.fileSources);
        if (registry === undefined) return;
        void readAccountList(ctx.secrets).then((list) => {
          for (const account of list.extra) {
            const own = requestsFor(ctx, opts, account.key);
            registry.register(new GoogleDriveFiles({ request: own.request, requestText: own.requestText, requestBytes: own.requestBytes, rules, folderIds: [], log: ctx.log, label: `drive:${account.key}`, title: `Google Drive · ${accountLabel(account)}` }));
          }
        }, () => undefined);
      });
    },
  };
}

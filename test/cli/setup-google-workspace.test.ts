import { describe, expect, it } from 'vitest';
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_SCOPE } from '../../src/connectors/google/oauth.js';
import {
  GOOGLE_CONTACTS_READ_SCOPE,
  GOOGLE_DOCS_READ_SCOPE,
  GOOGLE_SHEETS_READ_SCOPE,
  GOOGLE_SHEETS_SCOPE,
  GOOGLE_TASKS_SCOPE,
} from '../../src/connectors/google/workspace-scopes.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { ConfigInput } from '../../src/core/config/schema.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { featureRows } from '../../src/cli/features.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { askGoogle } from '../../src/cli/setup-google.js';
import type { ConnectGoogleOptions } from '../../src/cli/setup-google.js';
import { workspaceEntries, workspaceScopes } from '../../src/cli/setup-google-workspace.js';

const CLIENT_JSON = JSON.stringify({ installed: { client_id: 'client-id', client_secret: 'client-secret' } });

function existing(plugins: NonNullable<ConfigInput['plugins']>) {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: '11111111111111111' },
    plugins,
  });
}

async function run(answers: string[], missing: (scopes: readonly string[]) => string[] = () => [], config = existing({})) {
  const prompter = createScriptedPrompter(answers);
  const calls: ConnectGoogleOptions[] = [];
  const result = await askGoogle({
    prompter,
    secrets: new MemorySecretStore(),
    openUrl: async () => undefined,
    connectGoogle: async (opts) => {
      calls.push(opts);
      return { grantedScopes: [], missingScopes: missing(opts.extraScopes ?? []) };
    },
    readFile: async () => CLIENT_JSON,
    fileExists: async () => true,
    existing: config,
  });
  return { result, calls, said: prompter.said.join('\n'), remaining: prompter.remaining() };
}

describe('Google Workspace in setup', () => {
  it('asks one question and requests nothing extra when the owner says no', async () => {
    const { result, calls, remaining } = await run(['1', '/tmp/c.json', '1', '1']);
    expect(calls[0]?.extraScopes).toBeUndefined();
    expect(result.workspace).toBeUndefined();
    expect(remaining).toBe(0);
  });

  it('requests each chosen scope once, with Drive', async () => {
    const { result, calls, said } = await run(['1', '/tmp/c.json', '2', '2', '3', '3', '2', '2', '']);

    expect(calls[0]?.extraScopes).toEqual([
      GOOGLE_DRIVE_SCOPE,
      GOOGLE_DRIVE_FILE_SCOPE,
      GOOGLE_DOCS_READ_SCOPE,
      GOOGLE_SHEETS_READ_SCOPE,
      GOOGLE_SHEETS_SCOPE,
      GOOGLE_TASKS_SCOPE,
      GOOGLE_CONTACTS_READ_SCOPE,
    ]);
    expect(result.workspace).toEqual({
      'connector.google-docs': { enabled: true, level: 'create' },
      'connector.google-sheets': { enabled: true, write: true },
      'connector.google-tasks': { enabled: true },
      'connector.google-contacts': { enabled: true },
    });
    expect(said).toContain('Google Docs API, Google Sheets API, Google Tasks API, People API');
    expect(said).toContain('이제 할 일은 Google Tasks 기본 목록에 저장돼요');
    expect(said).toContain('plugins["skill.todo"].source');
  });

  it('keeps a part off when its scope was not ticked', async () => {
    const { result, said } = await run(['1', '/tmp/c.json', '1', '2', '1', '2', '1', '1'], () => [GOOGLE_SHEETS_READ_SCOPE]);
    expect(result.workspace).toEqual({ 'connector.google-sheets': { enabled: false, write: false } });
    expect(said).toContain('Google 시트(Sheets) 권한을 허용하지 않아');
  });

  it('keeps Sheets read-only when the write permission was not ticked', async () => {
    const { result, said } = await run(['1', '/tmp/c.json', '1', '2', '1', '3', '1', '1'], () => [GOOGLE_SHEETS_SCOPE]);
    expect(result.workspace).toEqual({ 'connector.google-sheets': { enabled: true, write: false } });
    expect(said).toContain('시트 고치기 권한을 허용하지 않아 Google 시트는 읽기만 돼요.');
  });

  it('switches off a part saved before and left out of this sign-in, keeping its other settings', () => {
    const prompter = createScriptedPrompter([]);
    const before = existing({ 'connector.google-contacts': { enabled: true, note: 'x' } });
    const choice = { docs: 'no', sheets: 'no', tasks: false, contacts: false } as const;
    expect(workspaceScopes(choice)).toEqual([]);
    expect(workspaceEntries(choice, [], prompter, before)).toEqual({ 'connector.google-contacts': { enabled: false, note: 'x' } });
  });
});

describe('ax-kit features rows', () => {
  it('shows Docs, Sheets, Tasks and Contacts with how to turn them on', async () => {
    const config = existing({
      'connector.google-sheets': { enabled: true, write: false },
      'connector.google-tasks': { enabled: true },
      'skill.todo': { enabled: true, source: 'local' },
    });
    const rows = await featureRows({
      config,
      secrets: new MemorySecretStore({ 'google.refresh-token': 't' }),
      home: '/h',
      exists: async () => false,
      hasCommand: async () => false,
      launchdLoaded: async () => false,
      pairedDevices: async () => 0,
      tailscaleUp: async () => false,
      stopped: async () => false,
    });
    const by = (id: string) => rows.find((row) => row.id === id);
    expect(by('docs')).toMatchObject({ group: 'Google', on: false });
    expect(by('docs')?.how).toContain('ax-kit connect google');
    expect(by('sheets')).toMatchObject({ on: true, name: 'Google 시트 읽기' });
    expect(by('tasks')?.on).toBe(false);
    expect(by('contacts')?.on).toBe(false);
  });
});

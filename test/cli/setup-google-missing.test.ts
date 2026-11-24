import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_SCOPE, GOOGLE_GMAIL_MODIFY_SCOPE } from '../../src/connectors/google/oauth.js';
import {
  GOOGLE_CONTACTS_READ_SCOPE,
  GOOGLE_DOCS_READ_SCOPE,
  GOOGLE_DOCS_SCOPE,
  GOOGLE_SHEETS_READ_SCOPE,
  GOOGLE_SHEETS_SCOPE,
  GOOGLE_TASKS_SCOPE,
} from '../../src/connectors/google/workspace-scopes.js';
import { loadConfig, parseConfig } from '../../src/core/config/load.js';
import type { ConfigInput } from '../../src/core/config/schema.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { featureRows } from '../../src/cli/features.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import type { ConnectGoogleOptions } from '../../src/cli/setup-google.js';
import { askGoogleMissing } from '../../src/cli/setup-google-missing.js';
import { runSetupMissing } from '../../src/cli/setup-missing.js';
import { CATALOG } from '../../src/app/llm-catalog.js';
import { docsScopes, workspaceEntries } from '../../src/cli/setup-google-workspace.js';

function config(plugins: NonNullable<ConfigInput['plugins']>) {
  return parseConfig({ version: 1, assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' }, channel: 'app', plugins });
}

const CONNECTED = {
  'connector.google-calendar': { enabled: true },
  'connector.gmail': { enabled: true },
  'connector.google-drive': { enabled: true, folderIds: ['f1'] },
  'connector.google-docs': { enabled: true },
  'connector.google-sheets': { enabled: true, write: false },
};

async function offIds(existing: ReturnType<typeof config>) {
  const rows = await featureRows({
    config: existing,
    secrets: new MemorySecretStore({ 'google.refresh-token': 't' }),
    home: '/h',
    exists: async () => false,
    hasCommand: async () => false,
    launchdLoaded: async () => true,
    pairedDevices: async () => 1,
    tailscaleUp: async () => false,
    stopped: async () => false,
  });
  return { rows, off: new Set(rows.filter((row) => !row.on).map((row) => row.id)) };
}

async function run(answers: string[], existing = config(CONNECTED), missing: string[] = []) {
  const prompter = createScriptedPrompter(answers);
  const calls: ConnectGoogleOptions[] = [];
  const secrets = new MemorySecretStore({ 'google.oauth-client': JSON.stringify({ clientId: 'cid', clientSecret: 'cs' }) });
  const { off } = await offIds(existing);
  const result = await askGoogleMissing(
    {
      prompter,
      secrets,
      openUrl: async () => undefined,
      connectGoogle: async (opts) => {
        calls.push(opts);
        return { grantedScopes: [], missingScopes: missing };
      },
      readFile: async () => {
        throw new Error('the saved client should be used');
      },
      fileExists: async () => false,
      existing,
    },
    off,
  );
  return { result, calls, said: prompter.said.join('\n'), remaining: prompter.remaining() };
}

describe('문서 고치기 scopes', () => {
  it('asks for documents instead of documents.readonly, never both', () => {
    expect(docsScopes('edit')).toEqual([GOOGLE_DOCS_SCOPE]);
    expect(docsScopes('read')).toEqual([GOOGLE_DOCS_READ_SCOPE]);
    expect(docsScopes('create')).toEqual([GOOGLE_DOCS_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE]);
  });

  it('saves the level that was granted', () => {
    const prompter = createScriptedPrompter([]);
    const choice = { docs: 'create', sheets: 'no', tasks: false, contacts: false } as const;
    expect(workspaceEntries(choice, [GOOGLE_DRIVE_FILE_SCOPE], prompter, undefined)).toEqual({ 'connector.google-docs': { enabled: true, level: 'read' } });
    expect(workspaceEntries({ ...choice, docs: 'edit' }, [GOOGLE_DOCS_SCOPE], prompter, undefined)).toEqual({ 'connector.google-docs': { enabled: false } });
    expect(prompter.said.join('\n')).toContain('Google 문서는 읽기만 돼요');
  });
});

describe('ax-kit setup, 꺼진 것만: Google', () => {
  it('lists the Google parts that are off, with how to turn each on', async () => {
    const { rows, off } = await offIds(config(CONNECTED));
    expect([...off].filter((id) => ['gmail-organize', 'drive', 'docs', 'docs-edit', 'sheets', 'tasks', 'contacts'].includes(id))).toEqual([
      'gmail-organize',
      'docs-edit',
      'tasks',
      'contacts',
    ]);
    const how = (id: string) => rows.find((row) => row.id === id)?.how ?? '';
    expect(how('docs-edit')).toBe('ax-kit setup → 꺼진 것만 이어서 설정 → "문서 고치기" 고르기 (또는 ax-kit connect google)');
    expect(how('gmail-organize')).toContain('"Gmail 정리"');
    expect(how('contacts')).toContain('꺼진 것만');
  });

  it('signs in once for everything on now plus what was picked, with the saved client', async () => {
    // Gate yes, Gmail 정리 yes, 문서 고치기 yes, 시트 고치기 no, Tasks no, 주소록 yes.
    const { result, calls, said, remaining } = await run(['2', '2', '2', '1', '1', '2']);

    expect(remaining).toBe(0);
    expect(said).toContain('꺼진 Google 기능: Gmail 정리, Google 문서 고치기, Google 시트 고치기, Google Tasks, Google 주소록');
    expect(said).toContain('지금 켜진 것(캘린더, Gmail, Drive, 문서, 시트)');
    expect(JSON.parse(calls[0]?.clientJson ?? '{}')).toEqual({ installed: { client_id: 'cid', client_secret: 'cs' } });
    expect(calls[0]?.extraScopes).toEqual([
      GOOGLE_DRIVE_SCOPE,
      GOOGLE_DRIVE_FILE_SCOPE,
      GOOGLE_GMAIL_MODIFY_SCOPE,
      GOOGLE_DOCS_SCOPE,
      GOOGLE_SHEETS_READ_SCOPE,
      GOOGLE_CONTACTS_READ_SCOPE,
    ]);
    expect(calls[0]?.extraScopes).not.toContain(GOOGLE_DOCS_READ_SCOPE);
    expect(calls[0]?.extraScopes).not.toContain(GOOGLE_TASKS_SCOPE);
    expect(result).toMatchObject({ calendar: true, gmail: true, drive: true, organize: true });
    expect(result.workspace).toEqual({
      'connector.google-docs': { enabled: true, level: 'edit' },
      'connector.google-sheets': { enabled: true, write: false },
      'connector.google-contacts': { enabled: true },
    });
    expect(said).not.toContain('folderIds');
  });

  it('does not sign in when nothing new is picked', async () => {
    const { result, calls, said } = await run(['2', '1', '1', '1', '1', '1']);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({});
    expect(said).toContain('Google은 그대로 둘게요.');
    expect((await run(['1'])).calls).toHaveLength(0);
  });

  it('offers a Docs level when Docs is off, and skips the step when everything is on', async () => {
    const existing = config({ ...CONNECTED, 'connector.google-docs': { enabled: false } });
    // Gate yes, Gmail 정리 no, Docs: 읽기만, 시트 고치기 no, Tasks no, 주소록 no.
    const { calls, said } = await run(['2', '1', '2', '1', '1', '1'], existing);
    expect(said).toContain('꺼진 Google 기능: Gmail 정리, Google 문서, Google 시트 고치기, Google Tasks');
    expect(calls[0]?.extraScopes).toContain(GOOGLE_DOCS_READ_SCOPE);
    expect(calls[0]?.extraScopes).not.toContain(GOOGLE_DOCS_SCOPE);

    const all = config({
      ...CONNECTED,
      'connector.gmail': { enabled: true, organize: true },
      'connector.google-docs': { enabled: true, level: 'edit' },
      'connector.google-sheets': { enabled: true, write: true },
      'connector.google-tasks': { enabled: true },
      'connector.google-contacts': { enabled: true },
    });
    const none = await run([], all);
    expect(none.result).toEqual({});
    expect(none.said).toBe('');
  });
});

describe('ax-kit setup, 꺼진 것만: 시트 읽기 → 읽기 + 고치기', () => {
  it('offers the upgrade when Sheets is read-only, with how in the table', async () => {
    const { rows, off } = await offIds(config(CONNECTED));
    expect(off.has('sheets')).toBe(false);
    expect(off.has('sheets-write')).toBe(true);
    expect(rows.find((row) => row.id === 'sheets-write')?.how).toContain('"읽기 + 고치기"');
    const written = await offIds(config({ ...CONNECTED, 'connector.google-sheets': { enabled: true, write: true } }));
    expect(written.off.has('sheets-write')).toBe(false);
    // Sheets off altogether: its own question already offers 읽기 + 고치기
    const none = await run(['2', '1', '1', '3', '1', '1'], config({ ...CONNECTED, 'connector.google-sheets': { enabled: false } }));
    expect(none.said).not.toContain('시트 고치기');
    expect(none.calls[0]?.extraScopes).toContain(GOOGLE_SHEETS_SCOPE);
  });

  it('asks for the write scope and keeps everything that is on', async () => {
    // Gate yes, Gmail 정리 no, 문서 고치기 no, 시트 고치기 yes, Tasks no, 주소록 no.
    const { result, calls, said, remaining } = await run(['2', '1', '1', '2', '1', '1']);
    expect(remaining).toBe(0);
    // read-only as well, so a "no" to 고치기 at Google keeps reading
    expect(calls[0]?.extraScopes).toEqual([GOOGLE_DRIVE_SCOPE, GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DOCS_READ_SCOPE, GOOGLE_SHEETS_READ_SCOPE, GOOGLE_SHEETS_SCOPE]);
    expect(result.workspace).toMatchObject({ 'connector.google-sheets': { enabled: true, write: true }, 'connector.google-docs': { enabled: true } });
    expect(said).toContain('Google 시트를 읽기·쓰기로 연결했어요.');
    // Sheets was on already: no API to switch on for it
    expect(said).not.toContain('Google Sheets API');
  });
});

describe('runSetupMissing', () => {
  it('walks only what is off, saves the upgrade and shows the table again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axkit-missing-'));
    try {
      const configFile = join(dir, 'config.json');
      const existing = config({ ...CONNECTED, 'connector.google-docs': { enabled: true, level: 'edit' } });
      const prompter = createScriptedPrompter(['2', '1', '2', '1', '1']);
      const secrets = new MemorySecretStore({
        'google.refresh-token': 't',
        'google.oauth-client': JSON.stringify({ clientId: 'cid', clientSecret: 'cs' }),
        [CATALOG[0]?.secret ?? 'x']: 'k',
      });
      const calls: ConnectGoogleOptions[] = [];
      const saved = await runSetupMissing({
        prompter,
        secrets,
        configFile,
        existing,
        features: (current) => ({
          config: current,
          secrets,
          home: dir,
          exists: async () => true,
          hasCommand: async () => true,
          launchdLoaded: async () => true,
          pairedDevices: async () => 1,
          tailscaleUp: async () => true,
          stopped: async () => false,
        }),
        google: {
          openUrl: async () => undefined,
          connectGoogle: async (opts) => (calls.push(opts), { grantedScopes: [], missingScopes: [] }),
          readFile: async () => {
            throw new Error('the saved client should be used');
          },
          fileExists: async () => false,
        },
      });
      expect(prompter.remaining()).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.extraScopes).toEqual(expect.arrayContaining([GOOGLE_DOCS_SCOPE, GOOGLE_SHEETS_SCOPE, GOOGLE_DRIVE_SCOPE]));
      expect(saved.plugins['connector.google-sheets']).toMatchObject({ enabled: true, write: true });
      expect(saved.plugins['connector.google-docs']).toMatchObject({ enabled: true, level: 'edit' });
      expect(saved.plugins['connector.google-drive']).toMatchObject({ enabled: true, folderIds: ['f1'] });
      expect((await loadConfig(configFile)).plugins['connector.google-sheets']).toMatchObject({ write: true });
      const table = prompter.said.at(-1) ?? '';
      expect(table).toMatch(/✓\s*Google 시트 고치기/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

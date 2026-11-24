import { describe, expect, it } from 'vitest';
import { featureRows, formatFeatures } from '../../src/cli/features.js';
import type { FeatureDeps } from '../../src/cli/features.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { WHISPER_MODEL_URL, setupTranscriber } from '../../src/cli/setup-transcribe.js';
import { updateCommand } from '../../src/cli/update.js';
import { parseConfig } from '../../src/core/config/load.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';

function deps(over: Partial<FeatureDeps> = {}, secrets: Record<string, string> = {}): FeatureDeps {
  return {
    config: parseConfig({ version: 1, assistant: { name: '비서', timezone: 'Asia/Seoul' }, channel: 'app', plugins: { 'connector.google-calendar': { enabled: true } } }),
    secrets: new MemorySecretStore(secrets),
    home: '/h',
    exists: async () => false,
    hasCommand: async () => false,
    launchdLoaded: async () => true,
    pairedDevices: async () => 1,
    tailscaleUp: async () => false,
    stopped: async () => false,
    ...over,
  };
}

describe('setup CLI (R18)', () => {
  it('lists what is on and how to turn on the rest', async () => {
    const rows = await featureRows(deps({}, { 'llm.deepseek.api-key': 'k', 'google.refresh-token': 't' }));
    const by = (id: string) => rows.find((row) => row.id === id);
    expect(by('service')?.on).toBe(true);
    expect(by('app')?.on).toBe(true);
    expect(by('pair')?.on).toBe(true);
    expect(by('ai')?.on).toBe(true);
    expect(by('calendar')?.on).toBe(true);
    expect(by('gmail')).toMatchObject({ on: false, how: 'ax-kit connect google' });
    expect(by('transcribe')?.on).toBe(false);
    expect(by('push')?.how).toContain('app.apns.key');
    const table = formatFeatures(rows);
    expect(table).toMatch(/^켜진 기능 \d+개 \/ 꺼진 기능 \d+개/);
    expect(table).toContain('✗ 푸시 알림');
    expect(table).not.toContain('켜는 법: ax-kit service install');
  });

  it('shows Gmail 정리 on only when the Gmail connector has the organize grant', async () => {
    const google = { 'google.refresh-token': 't' };
    const config = (gmail: Record<string, unknown>) =>
      parseConfig({ version: 1, assistant: { name: '비서', timezone: 'Asia/Seoul' }, channel: 'app', plugins: { 'connector.gmail': gmail } });
    const off = (await featureRows(deps({ config: config({ enabled: true }) }, google))).find((row) => row.id === 'gmail-organize');
    expect(off).toMatchObject({ on: false, how: expect.stringContaining('ax-kit connect google') });
    const on = (await featureRows(deps({ config: config({ enabled: true, organize: true }) }, google))).find((row) => row.id === 'gmail-organize');
    expect(on?.on).toBe(true);
  });

  it('installs speech-to-text only where it is missing, and resumes the model download', async () => {
    const ran: string[] = [];
    const moved: string[] = [];
    const base = { home: '/h', mkdir: async () => undefined, rename: async (a: string, b: string) => void moved.push(`${a}>${b}`), run: async (cmd: string, args: readonly string[]) => (ran.push([cmd, ...args].join(' ')), 0) };
    const ready = await setupTranscriber({ ...base, prompter: createScriptedPrompter([]), hasCommand: async () => true, exists: async () => true });
    expect(ready).toBe(true);
    expect(ran).toEqual([]);

    const done = await setupTranscriber({ ...base, prompter: createScriptedPrompter(['']), hasCommand: async (name) => name === 'brew', exists: async () => false });
    expect(done).toBe(true);
    expect(ran[0]).toBe('brew install whisper-cpp ffmpeg');
    expect(ran[1]).toContain('-C -');
    expect(ran[1]).toContain(WHISPER_MODEL_URL);
    expect(moved).toEqual(['/h/models/ggml-large-v3-turbo.bin.part>/h/models/ggml-large-v3-turbo.bin', '/h/models/ggml-silero-v5.1.2.bin.part>/h/models/ggml-silero-v5.1.2.bin']);

    const later = await setupTranscriber({ ...base, prompter: createScriptedPrompter(['2']), hasCommand: async () => false, exists: async () => false });
    expect(later).toBe(false);
  });

  it('updates fast-forward only and restarts the service when it is installed', async () => {
    const ran: string[] = [];
    const said: string[] = [];
    const code = await updateCommand((line) => said.push(line), async (cmd, args) => (ran.push(`${cmd} ${args.join(' ')}`), 0));
    expect(code).toBe(0);
    expect(ran[0]).toMatch(/^git -C .* pull --ff-only$/);
    expect(ran[1]).toBe('pnpm install --frozen-lockfile');
    expect(ran.some((line) => line.startsWith('launchctl kickstart -k'))).toBe(true);
    const failed = await updateCommand((line) => said.push(line), async (cmd) => (cmd === 'git' ? 1 : 0));
    expect(failed).toBe(1);
  });
});

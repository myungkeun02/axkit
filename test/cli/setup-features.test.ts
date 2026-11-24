import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../../src/core/config/load.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { runFeatureSetup } from '../../src/cli/setup-features.js';
import { FEATURES } from '../../src/cli/setup-optional.js';

const existing = parseConfig({ version: 1, assistant: { name: '비서', timezone: 'Asia/Seoul' }, channel: 'app', plugins: { 'skill.briefing': { enabled: true, at: '08:00' } } });
const n = (id: string): string => String(FEATURES.findIndex((feature) => feature.ids.includes(id)) + 1);

describe('ax-kit setup features', () => {
  it('turns the picked features on, keeps the rest of the config, offers 받아쓰기 and a restart, then sums up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axkit-features-'));
    try {
      const configFile = join(dir, 'config.json');
      let restarts = 0;
      // checklist: browser errands only, confirm it, skip 받아쓰기, restart now
      const prompter = createScriptedPrompter([n('connector.browser'), '1', '2', '1']);
      const config = await runFeatureSetup({
        prompter,
        secrets: new MemorySecretStore(),
        configFile,
        existing,
        transcribe: { home: dir, hasCommand: async () => false, exists: async () => false, run: async () => 1, mkdir: async () => undefined, rename: async () => undefined },
        restartService: async () => (restarts += 1, 0),
      });
      expect(prompter.remaining()).toBe(0);
      expect(config.plugins['connector.browser']).toEqual({ enabled: true });
      expect(config.plugins['skill.briefing']).toEqual({ enabled: true, at: '08:00' });
      expect((await loadConfig(configFile)).plugins['skill.browser']).toEqual({ enabled: true });
      expect(restarts).toBe(1);
      const said = prompter.said.join('\n');
      expect(said).toContain('1/2 · 선택 기능');
      expect(said).toContain('2/2 · 녹음 받아쓰기');
      expect(said).toMatch(/✔ 켜짐\s+브라우저 심부름/);
      expect(said).toMatch(/○ 꺼짐\s+녹음 받아쓰기/);
      expect(said).not.toContain('다시 시작하면 적용돼요');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

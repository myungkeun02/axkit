import { describe, expect, it } from 'vitest';
import { builtinPlugins } from '../../src/app/plugins.js';
import { todoSource } from '../../src/app/plugins-workspace.js';
import type { ConfigInput } from '../../src/core/config/schema.js';
import { parseConfig } from '../../src/core/config/load.js';
import { Contracts } from '../../src/core/contracts/index.js';

function config(plugins: NonNullable<ConfigInput['plugins']> = {}) {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: '11111111111111111' },
    plugins,
  });
}

const WORKSPACE = ['connector.google-docs', 'connector.google-sheets', 'connector.google-tasks', 'connector.google-contacts', 'skill.workspace'];

describe('Google Workspace wiring', () => {
  it('adds nothing until a part is switched on', () => {
    const found = builtinPlugins(config()).map((plugin) => plugin.manifest.id);
    for (const id of WORKSPACE) expect(found).not.toContain(id);
    expect(todoSource(config())).toBe('local');
    expect(builtinPlugins(config()).find((plugin) => plugin.manifest.id === 'skill.todo')?.manifest.needs).toBeUndefined();
  });

  it('adds the connectors that are on and one tools skill', () => {
    const plugins = builtinPlugins(
      config({
        'connector.google-docs': { enabled: true },
        'connector.google-sheets': { enabled: true, write: true },
        'connector.google-contacts': { enabled: true },
      }),
    );
    const found = plugins.map((plugin) => plugin.manifest.id);
    expect(found).toEqual(expect.arrayContaining(['connector.google-docs', 'connector.google-sheets', 'connector.google-contacts', 'skill.workspace']));
    expect(found).not.toContain('connector.google-tasks');
    const skill = plugins.find((plugin) => plugin.manifest.id === 'skill.workspace');
    expect(skill?.manifest.needs).toEqual(expect.arrayContaining([Contracts.docsRead, Contracts.sheetsWrite, Contracts.contactsRead]));
  });

  it('moves the to-do list to Google Tasks unless pinned to this Mac', () => {
    const tasks = config({ 'connector.google-tasks': { enabled: true } });
    const plugins = builtinPlugins(tasks);
    expect(todoSource(tasks)).toBe('backend');
    expect(plugins.map((plugin) => plugin.manifest.id)).toContain('connector.google-tasks');
    expect(plugins.find((plugin) => plugin.manifest.id === 'skill.todo')?.manifest.needs).toEqual([Contracts.todoBackend]);
    expect(plugins.map((plugin) => plugin.manifest.id)).not.toContain('skill.workspace');

    const pinned = config({ 'connector.google-tasks': { enabled: true }, 'skill.todo': { enabled: true, source: 'local' } });
    expect(todoSource(pinned)).toBe('local');
    expect(builtinPlugins(pinned).map((plugin) => plugin.manifest.id)).not.toContain('connector.google-tasks');
  });
});

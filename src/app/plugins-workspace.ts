import type { Config } from '../core/config/schema.js';
import type { Plugin } from '../core/plugin/types.js';
import {
  googleContactsConnector,
  googleDocsConnector,
  googleSheetsConnector,
  googleTasksConnector,
} from '../connectors/google/workspace-plugin.js';
import { docsLevelOf } from '../connectors/google/workspace-scopes.js';
import { workspaceSkill } from '../skills/workspace/plugin.js';

const optedIn = (config: Config, id: string): boolean => config.plugins[id]?.enabled === true;

/**
 * Where the to-do list lives. Google Tasks replaces the skill's own list once its connector is on; Apple Reminders
 * keeps the list on this Mac and syncs it both ways. plugins["skill.todo"].source pins it: "local", "google-tasks" or
 * "apple-reminders" (each only while its connector is on). Unpinned, Google Tasks comes first, as before.
 */
export function todoSource(config: Config): 'local' | 'backend' | 'synced' {
  const pinned = config.plugins['skill.todo']?.['source'];
  if (pinned === 'local') return 'local';
  const tasks = optedIn(config, 'connector.google-tasks');
  const reminders = optedIn(config, 'connector.apple-reminders');
  if (pinned === 'apple-reminders' && reminders) return 'synced';
  if (tasks) return 'backend';
  return reminders ? 'synced' : 'local';
}

/** Google Docs, Sheets, Tasks and Contacts: each off until setup saw its scope granted. */
export function workspacePlugins(config: Config): Plugin[] {
  const plugins: Plugin[] = [];
  const docs = optedIn(config, 'connector.google-docs');
  const sheets = optedIn(config, 'connector.google-sheets');
  const sheetsWrite = sheets && config.plugins['connector.google-sheets']?.['write'] === true;
  const contacts = optedIn(config, 'connector.google-contacts');
  if (docs) plugins.push(googleDocsConnector());
  if (sheets) plugins.push(googleSheetsConnector());
  if (contacts) plugins.push(googleContactsConnector());
  if (todoSource(config) === 'backend') plugins.push(googleTasksConnector());
  if ((docs || sheets || contacts) && config.plugins['skill.workspace']?.enabled !== false) {
    const docsLevel = docsLevelOf(config.plugins['connector.google-docs']);
    plugins.push(workspaceSkill({ docs, docsLevel, sheets, sheetsWrite, contacts }));
  }
  return plugins;
}

import { z } from 'zod';
import { wrapData } from '../../core/text/data.js';
import type { Tool } from '../../core/tools/types.js';
import type { MacAppsClient, RunningApp } from './client.js';
import type { AppCategory } from './policy.js';
import { categorize } from './policy.js';
import { renderNodes, resolveApp } from './resolve.js';

export interface MacAppSummary {
  name: string;
  bundle: string;
  active: boolean;
  /** What ax-kit may do there: "read-only" for banks and password managers, "ask" otherwise. */
  control: 'read-only' | 'ask';
}

export interface MacWindowOutput {
  app: string;
  bundle: string;
  window: string;
  truncated: boolean;
  /** One element per line, wrapped as data: an app's screen is never an instruction. */
  elements: string;
  note?: string;
}

const appsInput = z.object({});

const windowInput = z.object({
  app: z.string().min(1).max(120).optional().describe('Bundle id or name from mac.apps. Defaults to the frontmost app.'),
  maxDepth: z.number().int().min(1).max(25).optional().describe('How deep to read the element tree (default 12).'),
  maxNodes: z.number().int().min(20).max(1500).optional().describe('At most this many elements (default 400).'),
});

const selectedInput = z.object({
  app: z.string().min(1).max(120).optional().describe('Bundle id or name from mac.apps. Defaults to the frontmost app.'),
});

export type MacWindowInput = z.infer<typeof windowInput>;
export type MacSelectedInput = z.infer<typeof selectedInput>;

/** The named app, or the frontmost one, so policy is known before anything is read. */
async function targetApp(client: MacAppsClient, wanted: string | undefined): Promise<RunningApp | undefined> {
  if (wanted !== undefined) return resolveApp(client, wanted);
  return (await client.apps()).find((app) => app.active);
}

const readOnly = (category: AppCategory): boolean => category === 'money' || category === 'secret';

/** Tool "mac.apps": the running apps with a window, and whether ax-kit may act in each. */
export function macAppsTool(client: MacAppsClient): Tool<z.infer<typeof appsInput>, MacAppSummary[]> {
  return {
    name: 'mac.apps',
    description: 'List the apps running on this Mac (name, bundle id, which is in front, and whether ax-kit may act there).',
    input: appsInput,
    effects: ['read'],
    async run() {
      const apps = await client.apps();
      return apps.map((app) => ({
        name: app.name,
        bundle: app.bundle,
        active: app.active,
        control: readOnly(categorize(app)) ? 'read-only' : 'ask',
      }));
    },
  };
}

/** Tool "mac.read_window": the focused window's elements, bounded, with password fields blanked. */
export function macReadWindowTool(client: MacAppsClient): Tool<MacWindowInput, MacWindowOutput> {
  return {
    name: 'mac.read_window',
    description:
      'Read the focused window of a running app through Accessibility: roles, titles and values, one element per line ' +
      '("AXButton[저장]"). Use the shown roles and titles as mac.act targets. Password fields are never read.',
    input: windowInput,
    effects: ['read'],
    async run(input) {
      const app = await targetApp(client, input.app);
      // A password manager's fields are blanked inside the helper, so their values never leave it.
      const redact = app !== undefined && categorize(app) === 'secret';
      const snapshot = await client.window({
        ...(app !== undefined ? { bundle: app.bundle } : {}),
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
        ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
        ...(redact ? { redact: true } : {}),
      });
      const category = categorize(snapshot.app);
      // The frontmost app is known only after the read; its values are dropped here when it is a password manager.
      const nodes = category === 'secret' ? snapshot.nodes.map((node) => ({ ...node, value: '' })) : snapshot.nodes;
      const note = readOnly(category) ? '이 앱은 읽기만 해요. 누르거나 입력하지 않아요.' : undefined;
      return {
        app: snapshot.app.name,
        bundle: snapshot.app.bundle,
        window: snapshot.window,
        truncated: snapshot.truncated,
        elements: wrapData('mac.window', renderNodes(nodes)),
        ...(note !== undefined ? { note } : {}),
      };
    },
  };
}

/** Tool "mac.selected_text": the text selected in an app's focused element; never from a password field. */
export function macSelectedTextTool(client: MacAppsClient): Tool<MacSelectedInput, { app: string; text: string }> {
  return {
    name: 'mac.selected_text',
    description: 'Read the text the owner selected in a running app (defaults to the frontmost app).',
    input: selectedInput,
    effects: ['read'],
    async run(input) {
      const app = await targetApp(client, input.app);
      if (app !== undefined && categorize(app) === 'secret') return { app: app.name, text: '' };
      const selected = await client.selected(app?.bundle);
      if (categorize(selected.app) === 'secret') return { app: selected.app.name, text: '' };
      return { app: selected.app.name, text: wrapData('mac.selection', selected.text) };
    },
  };
}

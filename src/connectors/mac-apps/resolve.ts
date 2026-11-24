import type { MacAppsClient, RunningApp, TargetStep, WindowNode } from './client.js';
import { MacAppsError } from './client.js';

const STEP = /^(AX[A-Za-z]+)(?:\[(.+)\])?$/s;

/** "AXButton[보내기]" → { role: "AXButton", title: "보내기" }; "AXSheet" → { role: "AXSheet" }. */
export function parseStep(step: string): TargetStep | undefined {
  const match = STEP.exec(step.trim());
  if (match === null || match[1] === undefined) return undefined;
  const title = match[2]?.trim();
  return title === undefined || title === '' ? { role: match[1] } : { role: match[1], title };
}

const norm = (value: string): string => value.normalize('NFC').trim().toLowerCase();

/** The running app the owner named, by bundle id or by name. Two apps with the same name are not guessed. */
export async function resolveApp(client: MacAppsClient, wanted: string): Promise<RunningApp> {
  const key = norm(wanted);
  const apps = await client.apps();
  const byBundle = apps.find((app) => norm(app.bundle) === key);
  if (byBundle !== undefined) return byBundle;
  const byName = apps.filter((app) => norm(app.name) === key);
  if (byName.length > 1) throw new MacAppsError('ambiguous', wanted);
  const found = byName[0];
  if (found === undefined) throw new MacAppsError('not-running', wanted);
  return found;
}

/** One line per element, indented by depth: `AXButton[보내기] = "값" (disabled)`. */
export function renderNodes(nodes: readonly WindowNode[]): string {
  return nodes
    .map((node) => {
      const head = `${'  '.repeat(Math.min(node.depth, 20))}${node.role}${node.label !== '' ? `[${node.label}]` : ''}`;
      const flags = [node.secure ? 'password field' : '', node.disabled ? 'disabled' : '', node.focused ? 'focused' : '']
        .filter((flag) => flag !== '')
        .join(', ');
      const value = node.value !== '' ? ` = ${JSON.stringify(node.value)}` : '';
      return `${head}${value}${flags !== '' ? ` (${flags})` : ''}`;
    })
    .join('\n');
}

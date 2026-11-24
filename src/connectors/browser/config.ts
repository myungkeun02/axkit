import { z } from 'zod';
import type { Logger } from '../../core/log/types.js';

const cliCommand = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes('/') || value.startsWith('/'), {
    message: 'Use a plain command name or an absolute path.',
  });

const cliSchema = z.object({
  command: cliCommand,
  args: z.array(z.string()).default([]),
  timeoutSeconds: z.number().int().min(30).max(1800).default(600),
});

export const browserConfigSchema = z
  .object({
    adapter: z.enum(['playwright', 'cli']).default('playwright'),
    headless: z.boolean().default(true),
    readTimeoutSeconds: z.number().int().min(1).max(600).default(30),
    cli: cliSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.adapter === 'cli' && value.cli === undefined) {
      ctx.addIssue({ code: 'custom', path: ['cli'], message: 'The cli adapter needs cli.command.' });
    }
  });

export interface BrowserCliConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutSeconds: number;
}

export interface PlaywrightBrowserConfig {
  readonly adapter: 'playwright';
  readonly headless: boolean;
  readonly readTimeoutSeconds: number;
}

export interface CliBrowserConfig {
  readonly adapter: 'cli';
  readonly headless: boolean;
  readonly readTimeoutSeconds: number;
  readonly cli: BrowserCliConfig;
}

export type BrowserConfig = PlaywrightBrowserConfig | CliBrowserConfig;

export const DEFAULT_BROWSER_CONFIG: PlaywrightBrowserConfig = {
  adapter: 'playwright',
  headless: true,
  readTimeoutSeconds: 30,
};

/** Parses the plugin config; an invalid section falls back to the Playwright defaults. */
export function readBrowserConfig(config: unknown, log?: Logger): BrowserConfig {
  const parsed = browserConfigSchema.safeParse(config);
  if (!parsed.success) {
    log?.warn('browser: invalid config, using the Playwright defaults');
    return DEFAULT_BROWSER_CONFIG;
  }
  const { adapter, headless, readTimeoutSeconds, cli } = parsed.data;
  if (adapter === 'cli') {
    if (cli === undefined) return DEFAULT_BROWSER_CONFIG;
    return {
      adapter,
      headless,
      readTimeoutSeconds,
      cli: { command: cli.command, args: [...cli.args], timeoutSeconds: cli.timeoutSeconds },
    };
  }
  return { adapter, headless, readTimeoutSeconds };
}

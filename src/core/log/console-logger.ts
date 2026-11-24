import type { AuditEntry, AuditLog, Logger, LogLevel } from './types.js';
import { sanitize } from './sanitize.js';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  sink?: (line: string) => void;
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function writeLine(
  level: LogLevel,
  scope: string,
  minLevel: LogLevel,
  sink: (line: string) => void,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const entry: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
  };
  if (fields !== undefined) {
    const sanitized = sanitize(fields);
    if (sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
      Object.assign(entry, sanitized);
    }
  }
  sink(`${serialize(entry)}\n`);
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const scope = opts.scope ?? 'app';
  const sink = opts.sink ?? ((line: string): void => void process.stderr.write(line));

  const make = (currentScope: string): Logger => ({
    debug: (msg, fields) => writeLine('debug', currentScope, level, sink, msg, fields),
    info: (msg, fields) => writeLine('info', currentScope, level, sink, msg, fields),
    warn: (msg, fields) => writeLine('warn', currentScope, level, sink, msg, fields),
    error: (msg, fields) => writeLine('error', currentScope, level, sink, msg, fields),
    child: (childScope) => make(`${currentScope}.${childScope}`),
  });

  return make(scope);
}

const noop = (): void => undefined;

export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => silentLogger,
};

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry, at: new Date(entry.at) });
  }
}

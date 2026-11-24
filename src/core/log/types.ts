export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Append-only record of decisions and actions (tool calls, confirmations). Never holds secret values. */
export interface AuditEntry {
  at: Date;
  kind: string;
  subject: string;
  detail?: Record<string, unknown>;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
}

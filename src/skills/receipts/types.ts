export const DOC_KINDS = ['receipt', 'invoice', 'contract', 'statement'] as const;

export type DocKind = (typeof DOC_KINDS)[number];

export interface DocEntry {
  id: string;
  mailId: string;
  kind: DocKind;
  subject: string;
  from: string;
  /** ISO 8601 instant of the mail. */
  at: string;
  amount?: number;
  currency?: string;
  merchant?: string;
  merchantKey?: string;
  /** Vault-relative paths, POSIX separators. Empty when no vault root is configured. */
  files: string[];
}

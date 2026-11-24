/**
 * What a file connector may read. Defaults lean safe: text formats only, a size cap, and names that usually hold
 * keys, passwords or ID documents are never opened, even inside a folder the owner chose.
 */
export interface FileRules {
  extensions: readonly string[];
  maxBytes: number;
  /** Extra case-insensitive substrings; a path containing one is skipped. */
  exclude: readonly string[];
}

export const DEFAULT_FILE_RULES: FileRules = {
  extensions: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'org', 'rst', 'log'],
  maxBytes: 1_000_000,
  exclude: [],
};

const SENSITIVE_DIRS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.git',
  'node_modules',
  'keychains',
  '.trash',
  '.password-store',
]);

const SENSITIVE_NAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|kdbx|keychain(-db)?|ovpn|gpg|asc|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /(secret|credential|password|passwd|token|private[-_ ]?key|recovery[-_ ]?code|seed[-_ ]?phrase)/i,
  /(비밀번호|암호|주민등록|주민번호|여권|신분증|통장|계좌|보안카드|인증서)/,
  /(passport|ssn|social[-_ ]?security|bank[-_ ]?statement)/i,
];

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** True when any part of the path looks like it holds keys, passwords or identity documents. */
export function isSensitivePath(path: string, extra: readonly string[] = []): boolean {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  if (parts.some((part) => SENSITIVE_DIRS.has(part.toLowerCase()))) return true;
  const name = parts.at(-1) ?? '';
  if (SENSITIVE_NAMES.some((rule) => rule.test(name))) return true;
  const lower = path.toLowerCase();
  return extra.some((needle) => needle.trim() !== '' && lower.includes(needle.trim().toLowerCase()));
}

export type FileVerdict = 'ok' | 'sensitive' | 'type' | 'size';

export function fileVerdict(path: string, size: number, rules: FileRules, typeKnownAsText = false): FileVerdict {
  if (isSensitivePath(path, rules.exclude)) return 'sensitive';
  if (!typeKnownAsText && !rules.extensions.includes(extensionOf(path))) return 'type';
  if (size > rules.maxBytes) return 'size';
  return 'ok';
}

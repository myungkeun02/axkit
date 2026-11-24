interface PathRule {
  label: string;
  pattern: RegExp;
}

const PATH_RULES: readonly PathRule[] = [
  { label: '.github/workflows', pattern: /^\.github\/workflows\// },
  { label: '.env', pattern: /(^|\/)\.env(\.[^/]+)?$/ },
  { label: 'private key file', pattern: /\.(pem|key)$/i },
  { label: 'ssh private key', pattern: /(^|\/)id_rsa/i },
  { label: '.npmrc', pattern: /(^|\/)\.npmrc$/ },
  { label: '.git directory', pattern: /(^|\/)\.git\// },
];

/** Git paths use forward slashes; accepts either separator from callers. */
export function normalizeRepoPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** Paths a coder must never change: CI, secrets, keys and git internals. */
export function isProtectedPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return PATH_RULES.some((rule) => rule.pattern.test(normalized));
}

export function protectedPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => isProtectedPath(path));
}

interface SecretRule {
  kind: string;
  pattern: RegExp;
}

const SECRET_RULES: readonly SecretRule[] = [
  { kind: 'github-token', pattern: /ghp_[A-Za-z0-9]{20,}/g },
  { kind: 'github-token', pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  // The left boundary keeps ordinary words like "risk-management-plan" out of the scan.
  { kind: 'api-key', pattern: /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-key', pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'slack-token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
];

/** Names only, never the matched value: the names go into a log or an error message. */
export function findSecretKinds(text: string): string[] {
  const kinds = new Set<string>();
  for (const rule of SECRET_RULES) {
    if (new RegExp(rule.pattern.source, 'g').test(text)) kinds.add(rule.kind);
  }
  return [...kinds];
}

/** Replaces credential-looking text so logs, test tails and coder output can be shown safely. */
export function mask(text: string): string {
  let output = text;
  for (const rule of SECRET_RULES) {
    output = output.replace(new RegExp(rule.pattern.source, 'g'), '[masked]');
  }
  return output;
}

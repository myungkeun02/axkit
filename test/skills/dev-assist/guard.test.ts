import { describe, expect, it } from 'vitest';
import { findSecretKinds, isProtectedPath, mask, protectedPaths } from '../../../src/skills/dev-assist/guard.js';

const SECRETS = {
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  githubPat: 'github_pat_11ABCDEFGHIJKLMNOPQRST_abcdefghij',
  apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----',
  slack: 'xoxb-1234567890-abcdefghij',
} as const;

describe('dev-assist guard', () => {
  it('protects CI, env files, keys, npmrc and git internals', () => {
    const paths = [
      '.github/workflows/ci.yml',
      '.github/workflows/release/nightly.yml',
      '.env',
      '.env.local',
      'config/.env.production',
      'certs/server.pem',
      'certs/server.key',
      'keys/id_rsa',
      'keys/id_rsa.pub',
      '.npmrc',
      'packages/app/.npmrc',
      '.git/config',
      'sub/.git/HEAD',
    ];
    for (const path of paths) expect(isProtectedPath(path), path).toBe(true);
  });

  it('allows ordinary source and test files', () => {
    for (const path of ['src/app.ts', 'test/app.test.ts', '.gitignore', 'docs/environment.md', 'src/keyboard.ts']) {
      expect(isProtectedPath(path), path).toBe(false);
    }
  });

  it('keeps only the protected paths for a refusal message', () => {
    expect(protectedPaths(['src/a.ts', '.env', 'test/b.ts', '.github/workflows/ci.yml'])).toEqual([
      '.env',
      '.github/workflows/ci.yml',
    ]);
  });

  it('detects every credential family by name, never by value', () => {
    expect(findSecretKinds(`token ${SECRETS.github}`)).toEqual(['github-token']);
    expect(findSecretKinds(SECRETS.githubPat)).toEqual(['github-token']);
    expect(findSecretKinds(SECRETS.apiKey)).toEqual(['api-key']);
    expect(findSecretKinds(SECRETS.aws)).toEqual(['aws-key']);
    expect(findSecretKinds(SECRETS.privateKey)).toEqual(['private-key']);
    expect(findSecretKinds(SECRETS.slack)).toEqual(['slack-token']);
  });

  it('does not flag ordinary diff text', () => {
    const diff = `+const answer = 42;\n+export function greet(name: string) { return \`hi ${'${name}'}\`; }\n`;
    expect(findSecretKinds(diff)).toEqual([]);
    expect(findSecretKinds('a risk-management-plan document')).toEqual([]);
  });

  it('masks every match and leaves the rest intact', () => {
    const text = `before ${SECRETS.github} between ${SECRETS.aws} after`;
    const masked = mask(text);

    expect(masked).toBe('before [masked] between [masked] after');
    expect(masked).not.toContain(SECRETS.github);
    expect(masked).not.toContain(SECRETS.aws);
  });
});

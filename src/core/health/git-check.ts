import type { HealthCheck, HealthFinding } from '../contracts/health.js';
import type { ProcessRunner } from '../process/types.js';
import type { HealthTexts } from './builtin.js';

const GIT_TIMEOUT_MS = 15_000;

/**
 * The original assistant's daemon ran an uncommitted working copy (62 changed files) and stopped 70 deploys
 * on its way out. Running code is expected to be the committed code.
 */
export function uncommittedCodeCheck(opts: {
  codeDir: string;
  run: ProcessRunner;
  texts: HealthTexts;
}): HealthCheck {
  return {
    id: 'ops.uncommitted',
    async run(): Promise<readonly HealthFinding[]> {
      const result = await opts.run('git', ['-C', opts.codeDir, 'status', '--porcelain'], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        return [{ id: 'ops.uncommitted', area: 'ops', ok: true, line: opts.texts.notGitCheckout() }];
      }
      const count = result.stdout.split('\n').filter((line) => line.trim() !== '').length;
      if (count === 0) {
        return [{ id: 'ops.uncommitted', area: 'ops', ok: true, line: opts.texts.codeCommitted() }];
      }
      return [
        {
          id: 'ops.uncommitted',
          area: 'ops',
          ok: false,
          line: opts.texts.uncommittedChanges(count),
          fix: opts.texts.uncommittedFix(),
        },
      ];
    },
  };
}

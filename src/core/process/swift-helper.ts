import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessRunner } from './types.js';

export interface SwiftHelperSpec {
  /** Short file-safe name, e.g. "ax-read". */
  name: string;
  /** Absolute path of the .swift source shipped with the plugin. */
  sourcePath: string;
  /** Where compiled helpers are cached (~/.ax-kit/bin). */
  binDir: string;
  /** Extra frameworks to link, e.g. ["Vision", "PDFKit"]. */
  frameworks?: readonly string[];
  /**
   * An Info.plist embedded into the binary (`__TEXT,__info_plist`), for helpers that ask for a privacy permission
   * (Reminders) and must carry a usage description. Its contents take part in the version hash.
   */
  infoPlistPath?: string;
}

export interface SwiftHelperDeps {
  run: ProcessRunner;
  readSource?: (path: string) => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
}

const COMPILE_TIMEOUT_MS = 180_000;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compiles a plugin's Swift helper once per source version and returns the binary path.
 * The name carries a hash of the source, so an edited helper is rebuilt and an old binary is never run.
 */
export async function ensureSwiftHelper(spec: SwiftHelperSpec, deps: SwiftHelperDeps): Promise<string> {
  const read = deps.readSource ?? ((path: string) => readFile(path, 'utf8'));
  const source = await read(spec.sourcePath);
  const digest = createHash('sha256').update(source);
  if (spec.infoPlistPath !== undefined) digest.update('\0').update(await read(spec.infoPlistPath));
  const hash = digest.digest('hex').slice(0, 12);
  const binary = join(spec.binDir, `${spec.name}-${hash}`);
  if (await (deps.exists ?? fileExists)(binary)) return binary;

  await mkdir(spec.binDir, { recursive: true, mode: 0o700 });
  const frameworks = (spec.frameworks ?? []).flatMap((name) => ['-framework', name]);
  const plist =
    spec.infoPlistPath === undefined
      ? []
      : ['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', spec.infoPlistPath];
  const result = await deps.run('swiftc', ['-O', '-o', binary, spec.sourcePath, ...frameworks, ...plist], {
    timeoutMs: COMPILE_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(`swiftc could not build ${spec.name}: ${result.stderr.trim().slice(0, 300)}`);
  }
  await chmod(binary, 0o700);
  return binary;
}

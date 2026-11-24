import type { FileSource, FileSourceRegistry } from '../../core/contracts/files.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';

/** The sources every install may have; resolved on each call, so a connector that comes up late is still seen. */
function builtIn(ctx: PluginContext): FileSource[] {
  const sources: FileSource[] = [];
  const local = ctx.tryUse(Contracts.filesLocal);
  if (local !== undefined) sources.push(local);
  const drive = ctx.tryUse(Contracts.filesDrive);
  if (drive !== undefined) sources.push(drive);
  return sources;
}

/** The "files.sources" registry: built-in sources first, then the ones connectors registered, one per label. */
export class FileSources implements FileSourceRegistry {
  private readonly registered = new Map<string, FileSource>();

  constructor(private readonly ctx: PluginContext) {}

  register(source: FileSource): void {
    this.registered.set(source.label, source);
  }

  list(): FileSource[] {
    const sources = builtIn(this.ctx);
    const labels = new Set(sources.map((source) => source.label));
    for (const source of this.registered.values()) {
      if (!labels.has(source.label)) sources.push(source);
    }
    return sources;
  }
}

/** Every file source the index works over. */
export function sourcesOf(ctx: PluginContext): FileSource[] {
  return ctx.tryUse(Contracts.fileSources)?.list() ?? builtIn(ctx);
}

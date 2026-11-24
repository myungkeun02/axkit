import type { RemoteFoundFile, RemoteInfo, RemoteSource } from '../../core/contracts/remote.js';
import type { FolderScan, FolderScanner, FolderWalk, RepoDetails, RepoRoot, ScannedFile } from '../../core/contracts/scan.js';
import type { AgentSession, AgentSessionReader } from '../../core/contracts/sessions.js';
import { parseRemote, remoteId } from '../../core/remote/ids.js';
import {
  SOURCE_LIMITS,
  SOURCE_ROUTES,
  foundSchema,
  infoSchema,
  repoDetailsSchema,
  repoRootSchema,
  scannedFileSchema,
  sessionSchema,
  walkSchema,
} from '../../core/remote/protocol.js';
import { z } from 'zod';
import type { PostJson } from './http.js';
import { RemoteSourceError, nodePostJson } from './http.js';

export interface HttpRemoteSourceOptions {
  name: string;
  url: string;
  token: () => Promise<string | undefined>;
  post?: PostJson;
  /** Default 20 s; a walk gets six times that. */
  timeoutMs?: number;
}

const SMALL_BYTES = 2_000_000;
const LARGE_BYTES = 32_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * One paired Mac over HTTP. Ids and paths it hands out are namespaced: "remote:<name>:~/x" ids, "<name>:~/x"
 * citations; the prefix is stripped again before a request leaves.
 */
export class HttpRemoteSource implements RemoteSource {
  readonly scanner: FolderScanner;
  readonly sessions: AgentSessionReader;
  private readonly post: PostJson;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpRemoteSourceOptions) {
    this.post = options.post ?? nodePostJson;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.scanner = { open: (folders) => this.open(folders), locate: (path) => this.locate(path) };
    this.sessions = { list: (signal) => this.listSessions(signal), transcript: (session, maxChars) => this.transcript(session, maxChars) };
  }

  get name(): string {
    return this.options.name;
  }

  async info(): Promise<RemoteInfo> {
    return await this.call(SOURCE_ROUTES.info, {}, infoSchema);
  }

  async find(query: string, limit: number): Promise<readonly RemoteFoundFile[]> {
    const found = await this.call(SOURCE_ROUTES.find, { query, limit: Math.min(Math.max(1, limit), SOURCE_LIMITS.findResults) }, z.array(foundSchema));
    return found.map((file) => ({ ...file, id: this.id(file.path), path: this.cite(file.path) }));
  }

  private async call<T extends z.ZodType>(route: string, body: unknown, schema: T, opts: { large?: boolean; signal?: AbortSignal } = {}): Promise<z.infer<T>> {
    const token = await this.options.token();
    if (token === undefined) throw new RemoteSourceError('unauthorized', `No token is saved for ${this.name}.`);
    const raw = await this.post(this.options.url, route, body, {
      token,
      timeoutMs: opts.large === true ? this.timeoutMs * 6 : this.timeoutMs,
      maxBytes: opts.large === true ? LARGE_BYTES : SMALL_BYTES,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new RemoteSourceError('bad_response', `${this.name} sent an answer in an unexpected shape.`);
    return parsed.data as z.infer<T>;
  }

  private id(path: string): string {
    return remoteId(this.name, path);
  }

  private cite(path: string): string {
    return `${this.name}:${path}`;
  }

  /** The other Mac's own path for an id of this source; refuses ids of anything else. */
  private own(id: string): string {
    const parsed = parseRemote(id);
    if (parsed?.path === undefined || parsed.name.toLowerCase() !== this.name.toLowerCase()) {
      throw new RemoteSourceError('refused', `Not a path on ${this.name}.`);
    }
    return parsed.path;
  }

  private file(file: z.infer<typeof scannedFileSchema>): ScannedFile {
    return { ...file, id: this.id(file.id), path: this.cite(file.path) };
  }

  private open(folders: readonly string[]): FolderScan {
    const paths: string[] = [];
    let all = folders.length === 0;
    for (const folder of folders) {
      const parsed = parseRemote(folder);
      if (parsed === undefined || parsed.name.toLowerCase() !== this.name.toLowerCase()) continue;
      if (parsed.path === undefined) all = true;
      else paths.push(parsed.path);
    }
    return {
      walk: async (signal): Promise<FolderWalk> => {
        const walk = await this.call(SOURCE_ROUTES.walk, { all, folders: paths }, walkSchema, { large: true, ...(signal !== undefined ? { signal } : {}) });
        return {
          files: walk.files.map((file) => this.file(file)),
          repos: walk.repos.map((repo) => ({ ...repo, id: this.id(repo.id), path: this.cite(repo.path) })),
          truncated: walk.truncated,
        };
      },
      excerpt: async (id, maxBytes) => await this.call(SOURCE_ROUTES.excerpt, { id: this.own(id), maxBytes }, z.object({ text: z.string() })).then((r) => r.text),
      repo: async (id): Promise<RepoDetails> => {
        const details = await this.call(SOURCE_ROUTES.repo, { id: this.own(id) }, repoDetailsSchema);
        return { ...(details.readme !== undefined ? { readme: details.readme } : {}), commits: details.commits, languages: details.languages };
      },
      documentText: async (id, maxChars) => {
        const result = await this.call(SOURCE_ROUTES.documentText, { id: this.own(id), maxChars }, z.object({ text: z.string().optional() }));
        return result.text;
      },
      repoDocs: async (id, max) => {
        const docs = await this.call(SOURCE_ROUTES.repoDocs, { id: this.own(id), max }, z.array(scannedFileSchema));
        return docs.map((doc) => this.file(doc));
      },
    };
  }

  private async locate(path: string): Promise<RepoRoot | undefined> {
    const result = await this.call(SOURCE_ROUTES.locate, { path: this.own(path) }, z.object({ root: repoRootSchema.optional() }));
    const root = result.root;
    if (root === undefined) return undefined;
    return { root: this.id(root.root), display: this.cite(root.display), name: root.name, ...(root.remote !== undefined ? { remote: root.remote } : {}) };
  }

  private async listSessions(signal?: AbortSignal): Promise<readonly AgentSession[]> {
    const list = await this.call(SOURCE_ROUTES.sessions, {}, z.array(sessionSchema).max(5_000), { large: true, ...(signal !== undefined ? { signal } : {}) });
    return list.map((session) => {
      const { title, firstPrompt, gitBranch, gitRemote, ...rest } = session;
      return {
        ...rest,
        id: this.id(`/${session.id}`),
        cwd: this.id(session.cwd),
        ...(title !== undefined ? { title } : {}),
        ...(firstPrompt !== undefined ? { firstPrompt } : {}),
        ...(gitBranch !== undefined ? { gitBranch } : {}),
        ...(gitRemote !== undefined ? { gitRemote } : {}),
      };
    });
  }

  private async transcript(session: Pick<AgentSession, 'tool' | 'id'>, maxChars: number): Promise<string | undefined> {
    const own = this.own(session.id).slice(1);
    const result = await this.call(SOURCE_ROUTES.transcript, { tool: session.tool, id: own, maxChars }, z.object({ text: z.string().optional() }));
    return result.text;
  }
}

import { z } from 'zod';

/**
 * The wire format between `ax-kit source serve` (the work Mac) and connector.remote-sources (the assistant's Mac).
 * Paths travel as the work Mac sees them: "~/x" below its home, absolute otherwise. Every route is POST + JSON and,
 * except pairing, needs `Authorization: Bearer <token>`.
 */
export const SOURCE_ROUTES = {
  pair: '/v1/pair',
  info: '/v1/info',
  walk: '/v1/walk',
  excerpt: '/v1/excerpt',
  repo: '/v1/repo',
  repoDocs: '/v1/repo-docs',
  documentText: '/v1/document-text',
  locate: '/v1/locate',
  sessions: '/v1/sessions',
  transcript: '/v1/transcript',
  find: '/v1/find',
} as const;

export const DEFAULT_SOURCE_PORT = 7787;

/** Caps the work Mac enforces whatever the caller asks for. */
export const SOURCE_LIMITS = {
  excerptBytes: 256_000,
  documentChars: 200_000,
  transcriptChars: 400_000,
  repoDocs: 200,
  findResults: 50,
  walkEntries: 20_000,
  /** Request bodies are tiny; anything larger is refused. */
  requestBytes: 16_000,
} as const;

const iso = z.string().max(40);
const path = z.string().min(1).max(4_096);

export const scannedFileSchema = z.object({
  id: path,
  path,
  name: z.string().max(1_024),
  ext: z.string().max(40),
  size: z.number().nonnegative(),
  modifiedAt: iso,
  readable: z.boolean(),
});

export const scannedRepoSchema = z.object({ id: path, path, name: z.string().max(1_024), modifiedAt: iso });

export const walkSchema = z.object({
  files: z.array(scannedFileSchema).max(SOURCE_LIMITS.walkEntries),
  repos: z.array(scannedRepoSchema).max(SOURCE_LIMITS.walkEntries),
  truncated: z.boolean(),
});

export const repoDetailsSchema = z.object({
  readme: z.string().max(100_000).optional(),
  commits: z.array(z.object({ at: iso, subject: z.string().max(1_000) })).max(200),
  languages: z.array(z.object({ ext: z.string().max(40), files: z.number().nonnegative() })).max(500),
});

export const repoRootSchema = z.object({
  root: path,
  display: path,
  name: z.string().max(1_024),
  remote: z.string().max(1_024).optional(),
});

export const sessionSchema = z.object({
  tool: z.enum(['claude', 'codex']),
  id: z.string().min(1).max(512),
  cwd: path,
  title: z.string().max(1_000).optional(),
  firstPrompt: z.string().max(1_000).optional(),
  startedAt: iso,
  updatedAt: iso,
  turns: z.number().nonnegative(),
  gitBranch: z.string().max(500).optional(),
  gitRemote: z.string().max(1_024).optional(),
});

export const infoSchema = z.object({
  host: z.string().max(200),
  folders: z.array(z.string().max(4_096)).max(100),
  sessions: z.boolean(),
});

export const foundSchema = z.object({
  name: z.string().max(1_024),
  path,
  size: z.number().nonnegative(),
  modifiedAt: iso,
});

export const pairResponseSchema = z.object({ token: z.string().min(20).max(512), host: z.string().max(200) });

/** Request bodies, checked on the work Mac. */
export const sourceRequests = {
  pair: z.object({ code: z.string().min(1).max(40), name: z.string().min(1).max(80) }),
  walk: z.object({ all: z.boolean().default(false), folders: z.array(path).max(100).default([]) }),
  excerpt: z.object({ id: path, maxBytes: z.number().int().nonnegative() }),
  repo: z.object({ id: path }),
  repoDocs: z.object({ id: path, max: z.number().int().nonnegative() }),
  documentText: z.object({ id: path, maxChars: z.number().int().nonnegative() }),
  locate: z.object({ path }),
  transcript: z.object({ tool: z.enum(['claude', 'codex']), id: z.string().min(1).max(512), maxChars: z.number().int().nonnegative() }),
  find: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(SOURCE_LIMITS.findResults) }),
} as const;

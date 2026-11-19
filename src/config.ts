import { z } from 'zod';
import { DEFAULT_PASSAGE_TOKENS } from './domain/chunking.js';

/** Treat empty strings (e.g. `FOO=` in .env) as "not set" so defaults apply. */
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const positiveInt = (def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(def));

/** Local (host) database URL; also used by `pnpm migrate` when `DATABASE_URL` is unset. */
export const DEFAULT_DATABASE_URL = 'postgres://curie:curie@localhost:54329/curie';

/**
 * Default Gemini model: stable, free of charge on the Free Tier, structured output and thinking levels supported
 * (docs/notes/gemini-notes.md, UNVERIFIED). Not gemini-2.5-*: deprecated, auto-routed to 3.x from 2026-12-01.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** `MODEL_PROVIDER` values. */
export const MODEL_PROVIDERS = ['anthropic', 'gemini', 'fake'] as const;

/** pino levels (`silent` turns logging off). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const ConfigSchema = z
  .object({
    DATABASE_URL: z.preprocess(emptyToUndefined, z.string().url().default(DEFAULT_DATABASE_URL)),
    REDIS_URL: z.preprocess(emptyToUndefined, z.string().url().default('redis://localhost:63799')),
    MODEL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(MODEL_PROVIDERS).default('anthropic')),
    ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    ANTHROPIC_MODEL: z.preprocess(emptyToUndefined, z.string().default('claude-sonnet-5-5')),
    GEMINI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    GEMINI_MODEL: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_GEMINI_MODEL)),
    MAX_DOCUMENT_BYTES: positiveInt(5 * 1024 * 1024),
    FULL_CONTEXT_TOKENS: positiveInt(60_000),
    PASSAGE_TOKENS: positiveInt(DEFAULT_PASSAGE_TOKENS),
    MAX_ANSWER_TOKENS: positiveInt(1024),
    MODEL_TIMEOUT_MS: positiveInt(90_000),
    PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
    LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).default('info')),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.MODEL_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic (set MODEL_PROVIDER=fake for offline mode)',
      });
    }
    if (cfg.MODEL_PROVIDER === 'gemini' && !cfg.GEMINI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'GEMINI_API_KEY is required when MODEL_PROVIDER=gemini (set MODEL_PROVIDER=fake for offline mode)',
      });
    }
  });

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  modelProvider: (typeof MODEL_PROVIDERS)[number];
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  geminiApiKey: string | undefined;
  geminiModel: string;
  maxDocumentBytes: number;
  /** Fastify bodyLimit: JSON escaping can inflate content, so allow 1.5x; the exact byte check happens on `content`. */
  bodyLimitBytes: number;
  fullContextTokens: number;
  passageTokens: number;
  maxAnswerTokens: number;
  modelTimeoutMs: number;
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
};

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    modelProvider: e.MODEL_PROVIDER,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL,
    geminiApiKey: e.GEMINI_API_KEY,
    geminiModel: e.GEMINI_MODEL,
    maxDocumentBytes: e.MAX_DOCUMENT_BYTES,
    bodyLimitBytes: Math.ceil(e.MAX_DOCUMENT_BYTES * 1.5),
    fullContextTokens: e.FULL_CONTEXT_TOKENS,
    passageTokens: e.PASSAGE_TOKENS,
    maxAnswerTokens: e.MAX_ANSWER_TOKENS,
    modelTimeoutMs: e.MODEL_TIMEOUT_MS,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
  };
}

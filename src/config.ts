import { z } from 'zod';

/** Treat empty strings (e.g. `FOO=` in .env) as "not set" so defaults apply. */
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const positiveInt = (def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(def));

const ConfigSchema = z
  .object({
    DATABASE_URL: z.preprocess(
      emptyToUndefined,
      z.string().url().default('postgres://curie:curie@localhost:54329/curie'),
    ),
    REDIS_URL: z.preprocess(emptyToUndefined, z.string().url().default('redis://localhost:63799')),
    MODEL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['anthropic', 'fake']).default('anthropic')),
    ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    ANTHROPIC_MODEL: z.preprocess(emptyToUndefined, z.string().default('claude-sonnet-5-5')),
    MAX_DOCUMENT_BYTES: positiveInt(5 * 1024 * 1024),
    FULL_CONTEXT_TOKENS: positiveInt(60_000),
    PASSAGE_TOKENS: positiveInt(400),
    MAX_ANSWER_TOKENS: positiveInt(1024),
    MODEL_TIMEOUT_MS: positiveInt(90_000),
    PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.MODEL_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic (set MODEL_PROVIDER=fake for offline mode)',
      });
    }
  });

export type Env = z.infer<typeof ConfigSchema>;

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  modelProvider: 'anthropic' | 'fake';
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  maxDocumentBytes: number;
  /** Fastify bodyLimit: JSON escaping can inflate content, so allow 1.5x; the exact byte check happens on `content`. */
  bodyLimitBytes: number;
  fullContextTokens: number;
  passageTokens: number;
  maxAnswerTokens: number;
  modelTimeoutMs: number;
  port: number;
};

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
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
    maxDocumentBytes: e.MAX_DOCUMENT_BYTES,
    bodyLimitBytes: Math.ceil(e.MAX_DOCUMENT_BYTES * 1.5),
    fullContextTokens: e.FULL_CONTEXT_TOKENS,
    passageTokens: e.PASSAGE_TOKENS,
    maxAnswerTokens: e.MAX_ANSWER_TOKENS,
    modelTimeoutMs: e.MODEL_TIMEOUT_MS,
    port: e.PORT,
  };
}

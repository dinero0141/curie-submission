import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, DEFAULT_GEMINI_MODEL, loadConfig } from '../../src/config.js';
import { AnthropicModel } from '../../src/llm/anthropic.js';
import { ModelTimeoutError } from '../../src/llm/errors.js';
import { FakeModel } from '../../src/llm/fake.js';
import { GEMINI_THINKING_HEADROOM_TOKENS, GeminiModel, STRUCTURED_OUTPUT_HEADROOM_TOKENS } from '../../src/llm/gemini.js';
import { createAnswerModel } from '../../src/llm/index.js';
import { buildRequest } from '../../src/llm/prompt.js';

const fake = { MODEL_PROVIDER: 'fake' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(fake);
    expect(cfg).toMatchObject({
      modelProvider: 'fake',
      anthropicModel: 'claude-sonnet-5-5',
      maxDocumentBytes: 5 * 1024 * 1024,
      fullContextTokens: 60_000,
      passageTokens: 400,
      maxAnswerTokens: 1024,
      modelTimeoutMs: 90_000,
      port: 3000,
      logLevel: 'info',
    });
    expect(cfg.databaseUrl).toMatch(/^postgres:\/\//);
    expect(cfg.redisUrl).toMatch(/^redis:\/\//);
  });

  it('derives bodyLimit as 1.5x the document byte limit', () => {
    expect(loadConfig({ ...fake, MAX_DOCUMENT_BYTES: '1000' }).bodyLimitBytes).toBe(1500);
  });

  it('coerces numeric strings', () => {
    const cfg = loadConfig({ ...fake, PORT: '8080', FULL_CONTEXT_TOKENS: '1234', MODEL_TIMEOUT_MS: '5000' });
    expect(cfg.port).toBe(8080);
    expect(cfg.fullContextTokens).toBe(1234);
    expect(cfg.modelTimeoutMs).toBe(5000);
  });

  it('accepts a pino log level', () => {
    expect(loadConfig({ ...fake, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(loadConfig({ ...fake, LOG_LEVEL: '' }).logLevel).toBe('info');
  });

  it('treats empty strings as unset', () => {
    const cfg = loadConfig({ ...fake, PORT: '', ANTHROPIC_MODEL: '' });
    expect(cfg.port).toBe(3000);
    expect(cfg.anthropicModel).toBe('claude-sonnet-5-5');
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['PASSAGE_TOKENS', '0'],
    ['PASSAGE_TOKENS', '-5'],
    ['MAX_DOCUMENT_BYTES', '1.5'],
    ['DATABASE_URL', 'not a url'],
    ['MODEL_PROVIDER', 'openai'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadConfig({ ...fake, [key]: value })).toThrow(ConfigError);
    try {
      loadConfig({ ...fake, [key]: value });
    } catch (err) {
      expect((err as ConfigError).issues.join('\n')).toContain(key);
    }
  });

  it('requires ANTHROPIC_API_KEY when provider is anthropic (the default)', () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  ' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('accepts anthropic provider with a key and allows model override', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_MODEL: 'claude-other' });
    expect(cfg.modelProvider).toBe('anthropic');
    expect(cfg.anthropicApiKey).toBe('sk-test');
    expect(cfg.anthropicModel).toBe('claude-other');
  });

  it('does not require a key for the fake provider', () => {
    expect(loadConfig(fake).anthropicApiKey).toBeUndefined();
  });

  it('requires GEMINI_API_KEY when provider is gemini', () => {
    expect(() => loadConfig({ MODEL_PROVIDER: 'gemini' })).toThrow(/GEMINI_API_KEY is required when MODEL_PROVIDER=gemini/);
    expect(() => loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: ' ' })).toThrow(/GEMINI_API_KEY/);
    // An Anthropic key does not satisfy the gemini provider.
    expect(() => loadConfig({ MODEL_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'sk-test' })).toThrow(/GEMINI_API_KEY/);
  });

  it('accepts the gemini provider with a key, defaults the model, allows an override', () => {
    const cfg = loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test' });
    // The only model that answered the first live smoke run (gemini-3.8-flash was 503 "high demand" throughout).
    expect(cfg).toMatchObject({ modelProvider: 'gemini', geminiApiKey: 'g-test', geminiModel: 'gemini-3.5-flash-lite' });
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
    expect(cfg.anthropicApiKey).toBeUndefined();
    expect(loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test', GEMINI_MODEL: 'gemini-3.8-flash' }).geminiModel).toBe(
      'gemini-3.8-flash',
    );
    expect(loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test', GEMINI_MODEL: '' }).geminiModel).toBe('gemini-3.5-flash-lite');
  });

  it('stores a models/<id> GEMINI_MODEL (the resource name models.list prints) as the bare id', () => {
    const cfg = loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test', GEMINI_MODEL: 'models/gemini-3.6-flash' });
    expect(cfg.geminiModel).toBe('gemini-3.6-flash');
  });

  it('keeps anthropic the default provider and does not need a Gemini key for it', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(cfg.modelProvider).toBe('anthropic');
    expect(cfg.geminiApiKey).toBeUndefined();
  });
});

describe('createAnswerModel', () => {
  afterEach(() => vi.unstubAllGlobals());

  const tinyRequest = () => {
    const content = 'Alpha one.\n';
    const passages = [{ id: 'p0', heading: null, sentences: [{ start: 0, end: 10 }] }];
    return buildRequest({ documentTitle: 'T', content, passages, history: [], question: 'Alpha?' });
  };

  it('passes the Gemini config (model, key, answer budget, timeout) into GeminiModel', async () => {
    const calls: { url: string; headers: Headers; body: { generationConfig: { maxOutputTokens: number } } }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      const text = JSON.stringify({ notInDocument: true, segments: [] });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 });
    });
    const env = { MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-wired', GEMINI_MODEL: 'gemini-3.6-flash', ANTHROPIC_API_KEY: 'sk-other', MAX_ANSWER_TOKENS: '777' };
    const raw = await createAnswerModel(loadConfig(env)).generate(tinyRequest(), () => {}, new AbortController().signal);
    expect(raw.model).toBe('gemini-3.6-flash');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe('g-wired');
    expect(calls[0]!.body.generationConfig.maxOutputTokens).toBe(777 + STRUCTURED_OUTPUT_HEADROOM_TOKENS + GEMINI_THINKING_HEADROOM_TOKENS);
  });

  it('passes MODEL_TIMEOUT_MS into GeminiModel', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    const cfg = loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-wired', MODEL_TIMEOUT_MS: '30' });
    const err = await createAnswerModel(cfg).generate(tinyRequest(), () => {}, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelTimeoutError);
    expect((err as ModelTimeoutError).timeoutMs).toBe(30);
  });

  it('builds the model for each provider', () => {
    expect(createAnswerModel(loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test' }))).toBeInstanceOf(GeminiModel);
    expect(createAnswerModel(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }))).toBeInstanceOf(AnthropicModel);
    expect(createAnswerModel(loadConfig(fake))).toBeInstanceOf(FakeModel);
  });
});

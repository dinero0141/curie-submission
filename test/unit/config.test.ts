import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_GEMINI_MODEL, loadConfig } from '../../src/config.js';
import { AnthropicModel } from '../../src/llm/anthropic.js';
import { FakeModel } from '../../src/llm/fake.js';
import { GeminiModel } from '../../src/llm/gemini.js';
import { createAnswerModel } from '../../src/llm/index.js';

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
    expect(cfg).toMatchObject({ modelProvider: 'gemini', geminiApiKey: 'g-test', geminiModel: 'gemini-3.8-flash' });
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.8-flash');
    expect(cfg.anthropicApiKey).toBeUndefined();
    expect(loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test', GEMINI_MODEL: 'gemini-3.5-flash-lite' }).geminiModel).toBe(
      'gemini-3.5-flash-lite',
    );
    expect(loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test', GEMINI_MODEL: '' }).geminiModel).toBe('gemini-3.8-flash');
  });

  it('keeps anthropic the default provider and does not need a Gemini key for it', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(cfg.modelProvider).toBe('anthropic');
    expect(cfg.geminiApiKey).toBeUndefined();
  });
});

describe('createAnswerModel', () => {
  it('builds the model for each provider', () => {
    expect(createAnswerModel(loadConfig({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test' }))).toBeInstanceOf(GeminiModel);
    expect(createAnswerModel(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }))).toBeInstanceOf(AnthropicModel);
    expect(createAnswerModel(loadConfig(fake))).toBeInstanceOf(FakeModel);
  });
});

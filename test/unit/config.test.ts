import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

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
});

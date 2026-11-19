/** Model selection from config (`MODEL_PROVIDER`). */
import type { Config } from '../config.js';
import { AnthropicModel } from './anthropic.js';
import { FakeModel } from './fake.js';
import type { AnswerModel } from './types.js';

export function createAnswerModel(config: Config): AnswerModel {
  if (config.modelProvider === 'fake') return new FakeModel();
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic');
  return new AnthropicModel({
    apiKey: config.anthropicApiKey,
    model: config.anthropicModel,
    maxAnswerTokens: config.maxAnswerTokens,
    timeoutMs: config.modelTimeoutMs,
  });
}

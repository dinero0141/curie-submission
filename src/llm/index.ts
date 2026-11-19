/** Model selection from config (`MODEL_PROVIDER`). */
import type { Config } from '../config.js';
import { AnthropicModel } from './anthropic.js';
import { FakeModel } from './fake.js';
import type { AnswerModel } from './types.js';

export function createAnswerModel(config: Config): AnswerModel {
  if (config.modelProvider === 'fake') return new FakeModel();
  return new AnthropicModel({
    apiKey: config.anthropicApiKey!, // loadConfig refuses MODEL_PROVIDER=anthropic without a key
    model: config.anthropicModel,
    maxAnswerTokens: config.maxAnswerTokens,
    timeoutMs: config.modelTimeoutMs,
  });
}

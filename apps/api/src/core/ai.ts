import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { Config } from './config.ts';

// AI provider (PRD M14 rules; T-116; Philip chose Claude, 2026-11-08). One interface, so the
// features never name a vendor: Claude in staging and production, a fake locally and in tests,
// and "off" when no key has been set. AI only ever reads: the tools it gets return figures,
// and nothing here changes data. Prompts and answers are never logged.

export interface AiTool {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface AiRequest {
  /** Fixed instructions: nothing that varies per call goes here. */
  system: string;
  user: string;
  tools?: readonly AiTool[];
  /** Runs a tool the model asked for and answers its result as text. */
  runTool?: (name: string, input: unknown) => Promise<string>;
  effort?: 'low' | 'medium' | 'high';
}

export interface AiResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  readonly name: 'OFF' | 'FAKE' | 'ANTHROPIC';
  generate(request: AiRequest): Promise<AiResult>;
}

/** The model could not answer: not configured, unreachable, or it declined. */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

const MAX_TOOL_ROUNDS = 4;
// A safety decline on the main model is retried on another, in the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createClaudeProvider(options: {
  apiKey: string;
  model: string;
  client?: Anthropic;
}): AiProvider {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: 60_000 });
  return {
    name: 'ANTHROPIC',
    async generate(request) {
      const tools = (request.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: 'object' as const, ...t.inputSchema },
        strict: true,
      }));
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: request.user }];
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const response = await client.beta.messages.create({
            model: options.model,
            max_tokens: 16_000,
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            system: request.system,
            output_config: { effort: request.effort ?? 'medium' },
            ...(tools.length > 0 ? { tools } : {}),
            messages,
          } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
          inputTokens += response.usage.input_tokens;
          outputTokens += response.usage.output_tokens;
          if (response.stop_reason === 'refusal') {
            throw new AiUnavailableError('The model declined this request');
          }
          if (response.stop_reason !== 'tool_use') {
            const text = response.content
              .flatMap((b) => (b.type === 'text' ? [b.text] : []))
              .join('\n')
              .trim();
            if (!text) throw new AiUnavailableError('The model gave no answer');
            return { text, inputTokens, outputTokens };
          }
          // The whole turn goes back unchanged, thinking blocks included.
          messages.push({ role: 'assistant', content: response.content });
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            try {
              const content = await (request.runTool?.(block.name, block.input) ??
                Promise.reject(new Error('No tools here')));
              results.push({ type: 'tool_result', tool_use_id: block.id, content });
            } catch (err) {
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: err instanceof Error ? err.message : 'That report is not available',
              });
            }
          }
          messages.push({ role: 'user', content: results });
        }
      } catch (err) {
        if (err instanceof AiUnavailableError) throw err;
        if (err instanceof Anthropic.APIError) {
          throw new AiUnavailableError(`Claude answered ${String(err.status ?? 'no status')}`);
        }
        if (err instanceof Anthropic.APIConnectionError) {
          throw new AiUnavailableError('Claude could not be reached');
        }
        throw err;
      }
      throw new AiUnavailableError('The model did not finish');
    },
  };
}

export function createOffProvider(): AiProvider {
  return {
    name: 'OFF',
    generate: () => Promise.reject(new AiUnavailableError('AI is not switched on')),
  };
}

export interface FakeAiProvider extends AiProvider {
  /** Replaces the fake's answer, for tests. */
  respond: ((request: AiRequest) => Promise<string> | string) | null;
  readonly requests: AiRequest[];
}

/** Answers without a network: the first tool's result, or the start of the facts it was given. */
export function createFakeAiProvider(logger?: Logger): FakeAiProvider {
  const fake: FakeAiProvider = {
    name: 'FAKE',
    respond: null,
    requests: [],
    async generate(request) {
      fake.requests.push(request);
      logger?.info('AI (not called, fake provider)');
      let text: string;
      if (fake.respond) {
        text = await fake.respond(request);
      } else if (request.tools?.[0] && request.runTool) {
        const [tool] = request.tools;
        text = await request.runTool(tool.name, { date: null }).then(
          (result) =>
            `From the ${tool.name.replace('get_', '').replace('_', ' ')}: ${result.slice(0, 300)}`,
          () => 'Thank you. (The local stand-in for the AI has no real answer to give.)',
        );
      } else {
        text = request.user.slice(0, 300);
      }
      return { text, inputTokens: 10, outputTokens: 10 };
    },
  };
  return fake;
}

/** The provider the configuration names (AI_PROVIDER). */
export function createAiProvider(config: Config, logger: Logger): AiProvider {
  if (config.ai.provider === 'anthropic') {
    return createClaudeProvider({ apiKey: config.ai.apiKey ?? '', model: config.ai.model });
  }
  return config.ai.provider === 'fake' ? createFakeAiProvider(logger) : createOffProvider();
}

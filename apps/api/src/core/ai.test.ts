import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AiUnavailableError, createClaudeProvider, createOffProvider } from './ai.ts';

// The Claude adapter (T-116), against a stand-in for the SDK client: no network.

const text = (t: string) => ({
  content: [{ type: 'text', text: t }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 7 },
});

function withReplies(...replies: unknown[]) {
  const create = vi.fn();
  for (const r of replies) {
    if (r instanceof Error) create.mockRejectedValueOnce(r);
    else create.mockResolvedValueOnce(r);
  }
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { create, ai: createClaudeProvider({ apiKey: 'x', model: 'claude-opus-5-5', client }) };
}

const REQUEST = { system: 'S', user: 'U' };

describe('Claude adapter', () => {
  it('sends the model and fallback, and answers the text with its token counts', async () => {
    const { ai, create } = withReplies(text('Hello'));
    await expect(ai.generate(REQUEST)).resolves.toEqual({
      text: 'Hello',
      inputTokens: 5,
      outputTokens: 7,
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'S',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      messages: [{ role: 'user', content: 'U' }],
    });
  });

  it('runs tools, returns the whole turn and adds up the tokens', async () => {
    const turn = {
      content: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'tool_use', id: 't1', name: 'get_flash_report', input: { date: null } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const { ai, create } = withReplies(turn, text('Done'));
    const runTool = vi.fn().mockResolvedValue('{"roomsSold":3}');
    const result = await ai.generate({
      ...REQUEST,
      tools: [{ name: 'get_flash_report', description: 'D', inputSchema: { properties: {} } }],
      runTool,
    });
    expect(result).toEqual({ text: 'Done', inputTokens: 6, outputTokens: 9 });
    expect(runTool).toHaveBeenCalledWith('get_flash_report', { date: null });
    const second = create.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(second.messages[1]).toEqual({ role: 'assistant', content: turn.content });
    expect(second.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"roomsSold":3}' }],
    });
  });

  it('a tool that fails goes back as an error, so the model can say so', async () => {
    const turn = {
      content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const { ai, create } = withReplies(turn, text('No report for that day'));
    await ai.generate({
      ...REQUEST,
      tools: [{ name: 'x', description: 'D', inputSchema: {} }],
      runTool: () => Promise.reject(new Error('No closed day')),
    });
    const second = create.mock.calls[1]?.[0] as { messages: { content: unknown }[] };
    expect(second.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'No closed day' },
    ]);
  });

  it('a decline, an empty answer, an API error and a runaway loop are all unavailable', async () => {
    const refused = {
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    await expect(withReplies(refused).ai.generate(REQUEST)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    await expect(withReplies(text('')).ai.generate(REQUEST)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    const apiError = new Anthropic.RateLimitError(429, undefined, 'Slow down', new Headers());
    await expect(withReplies(apiError).ai.generate(REQUEST)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    const again = {
      content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const { ai, create } = withReplies(again, again, again, again, again);
    await expect(
      ai.generate({
        ...REQUEST,
        tools: [{ name: 'x', description: 'D', inputSchema: {} }],
        runTool: () => Promise.resolve('{}'),
      }),
    ).rejects.toBeInstanceOf(AiUnavailableError);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('off is always unavailable', async () => {
    await expect(createOffProvider().generate(REQUEST)).rejects.toBeInstanceOf(AiUnavailableError);
  });
});

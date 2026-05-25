import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './system-prompt';
import { TOOLS, executeTool } from './tools';

const client = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

export interface AgentCallbacks {
  onText: (chunk: string) => void;
  onToolStart: (name: string, input: Record<string, unknown>) => void;
  onToolEnd: (name: string, result: string) => void;
}

export async function runAgent(
  history: Anthropic.MessageParam[],
  callbacks: AgentCallbacks,
): Promise<Anthropic.MessageParam[]> {
  const messages = [...history];

  while (true) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    });

    stream.on('text', callbacks.onText);

    const response = await stream.finalMessage();
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const input = block.input as Record<string, unknown>;
      callbacks.onToolStart(block.name, input);
      const result = await executeTool(block.name, input);
      callbacks.onToolEnd(block.name, result);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return messages;
}

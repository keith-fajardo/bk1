import { useState, useEffect, useRef, useCallback } from 'react';
import { createCliRenderer } from '@gridland/bun';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent } from './agent';
import { PROJECT_DIR } from './tools';

interface ToolEvent {
  name: string;
  result?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolEvent[];
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [liveText, setLiveText] = useState('');
  const [activeTool, setActiveTool] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  const inputRef = useRef('');
  const isRunningRef = useRef(false);
  const historyRef = useRef<Anthropic.MessageParam[]>([]);

  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);

  const submit = useCallback(async () => {
    const userText = inputRef.current.trim();
    if (!userText || isRunningRef.current) return;

    setInput('');
    inputRef.current = '';
    isRunningRef.current = true;
    setIsRunning(true);
    setLiveText('');

    setMessages(prev => [...prev, { role: 'user', content: userText }]);
    historyRef.current.push({ role: 'user', content: userText });

    let fullText = '';
    const toolLog: ToolEvent[] = [];

    try {
      const updated = await runAgent(historyRef.current, {
        onText: (chunk) => {
          fullText += chunk;
          setLiveText(fullText);
        },
        onToolStart: (name) => {
          setActiveTool(name);
          toolLog.push({ name });
        },
        onToolEnd: (_name, result) => {
          setActiveTool('');
          if (toolLog.length > 0) {
            toolLog[toolLog.length - 1]!.result = result.substring(0, 300);
          }
          fullText += '\n';
          setLiveText(fullText);
        },
      });

      historyRef.current = updated;
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: fullText.trim(), tools: toolLog },
      ]);
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setLiveText('');
      setActiveTool('');
      setIsRunning(false);
      isRunningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onKey = (key: string) => {
      if (key === '') process.exit(0);
      if (isRunningRef.current) return;

      if (key === '\r' || key === '\n') {
        void submit();
      } else if (key === '') {
        const next = inputRef.current.slice(0, -1);
        inputRef.current = next;
        setInput(next);
      } else if (key.charCodeAt(0) >= 32) {
        const next = inputRef.current + key;
        inputRef.current = next;
        setInput(next);
      }
    };

    process.stdin.on('data', onKey);
    return () => { process.stdin.off('data', onKey); };
  }, [submit]);

  return (
    <box flexDirection="column" height="100%">
      <box paddingX={2} paddingTop={1} paddingBottom={0}>
        <text bold color="cyan">dbt Agent</text>
        <text dimColor>  {PROJECT_DIR}</text>
      </box>

      <box flex={1} flexDirection="column" paddingX={2} paddingTop={1} overflowY="scroll">
        {messages.length === 0 && (
          <text dimColor>Ask anything about your dbt project. Press Ctrl+C to exit.</text>
        )}

        {messages.map((msg, i) => (
          <box key={i} flexDirection="column" marginBottom={1}>
            <text bold color={msg.role === 'user' ? 'green' : 'blue'}>
              {msg.role === 'user' ? 'You' : 'Agent'}
            </text>
            <text wrap="wrap">{msg.content}</text>
            {msg.tools && msg.tools.length > 0 && (
              <box flexDirection="column" marginTop={0} marginLeft={2}>
                {msg.tools.map((t, j) => (
                  <text key={j} dimColor>ran {t.name}</text>
                ))}
              </box>
            )}
          </box>
        ))}

        {isRunning && (
          <box flexDirection="column" marginBottom={1}>
            <text bold color="blue">Agent</text>
            {activeTool
              ? <text dimColor>Running {activeTool}...</text>
              : <text wrap="wrap">{liveText || '...'}</text>
            }
          </box>
        )}
      </box>

      <box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={2} paddingY={0} flexDirection="row">
        <text color={isRunning ? 'gray' : 'green'}>{isRunning ? '  ' : '> '}</text>
        <text>{input}</text>
        {!isRunning && <text color="green">|</text>}
      </box>
    </box>
  );
}

createCliRenderer(<App />);

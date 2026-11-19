import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoryRenderer, describeTool, joinLines, quote } from '../services/historyRenderer.js';
import type { ToolPart } from '../types/index.js';

const OPTIONS = { toolCalls: true, toolCallsFlushSeconds: 30 };

function tool(id: string, command: string, status: 'completed' | 'error' | 'running' = 'completed'): ToolPart {
  return { id, sessionID: 'session-1', messageID: 'message-1', tool: 'bash', state: { status, input: { command } } };
}

describe('HistoryRenderer', () => {
  let sent: string[];
  let send: (content: string) => Promise<boolean>;

  beforeEach(() => {
    sent = [];
    send = vi.fn(async (content: string) => {
      sent.push(content);
      return true;
    });
  });

  it('posts a step once it is complete, and only once', async () => {
    const renderer = new HistoryRenderer(send, OPTIONS);

    renderer.onText('step-1', 'Looking', false);
    renderer.onText('step-1', 'Looking at the data', true);
    renderer.onText('step-1', 'Looking at the data', true);
    await renderer.finish();

    expect(sent).toEqual(['Looking at the data']);
    expect(renderer.messageCount).toBe(1);
  });

  it('posts a step when the next one starts, keeping the order', async () => {
    const renderer = new HistoryRenderer(send, OPTIONS);

    renderer.onText('step-1', 'first', false);
    renderer.onText('step-2', 'second', false);
    await renderer.finish();

    expect(sent).toEqual(['first', 'second']);
  });

  it('batches the tool calls before the next step', async () => {
    const renderer = new HistoryRenderer(send, OPTIONS);

    renderer.onText('step-1', 'Running the tests', true);
    renderer.onTool(tool('tool-1', 'npm test', 'running'));
    renderer.onTool(tool('tool-1', 'npm test'));
    renderer.onTool(tool('tool-2', 'cat out.log', 'error'));
    renderer.onText('step-2', 'They pass', true);
    await renderer.finish();

    expect(sent).toEqual([
      'Running the tests',
      "-# 🔧 **bash** `npm test`\n-# ❌ **bash** `cat out.log`",
      'They pass',
    ]);
  });

  it('leaves the tool calls out when toolCalls is off', async () => {
    const renderer = new HistoryRenderer(send, { ...OPTIONS, toolCalls: false });

    renderer.onTool(tool('tool-1', 'npm test'));
    await renderer.finish();

    expect(sent).toEqual([]);
  });

  it('quotes a message that reached the session from elsewhere', async () => {
    const renderer = new HistoryRenderer(send, OPTIONS);

    renderer.onText('step-1', 'Working', true);
    renderer.onUserMessage('user-1', 'Please also check\nthe logs');
    renderer.onUserMessage('user-1', 'Please also check\nthe logs');
    await renderer.finish();

    expect(sent).toEqual(['Working', '> 💬 **Message to the agent:**\n> Please also check\n> the logs']);
  });

  describe('periodic posting of the tool calls', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('posts the pending tool call lines every toolCallsFlushSeconds', async () => {
      const renderer = new HistoryRenderer(send, OPTIONS);
      renderer.start();

      renderer.onTool(tool('tool-1', 'sleep 600'));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(sent).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual(['-# 🔧 **bash** `sleep 600`']);

      await renderer.finish();
    });
  });
});

describe('describeTool', () => {
  it('shortens a long subject to one line', () => {
    const line = describeTool(tool('tool-1', `python -c "${'x'.repeat(300)}"\nprint(1)`));

    expect(line.startsWith('-# 🔧 **bash** `python -c')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(200);
  });

  it('replaces the backticks that would break the code span', () => {
    expect(describeTool(tool('tool-1', 'echo `date`'))).toBe("-# 🔧 **bash** `echo 'date'`");
  });
});

describe('joinLines', () => {
  it('splits the lines into messages under the length limit', () => {
    const chunks = joinLines(Array.from({ length: 30 }, () => 'x'.repeat(100)));

    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= 1900)).toBe(true);
  });
});

describe('quote', () => {
  it('cuts a long text to fit in one message', () => {
    expect(quote('x'.repeat(5000), 'header').length).toBeLessThan(2000);
  });
});

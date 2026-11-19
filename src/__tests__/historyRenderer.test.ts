import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoryRenderer, describeBackgroundProcessExit, describeTool, joinLines, quote, quoteChunks } from '../services/historyRenderer.js';
import type { ToolPart } from '../types/index.js';
import type { HistoryMessageKind } from '../services/configStore.js';

const OPTIONS = { toolCalls: true, toolCallsFlushSeconds: 30, reasoning: false, silent: [] as HistoryMessageKind[] };

function tool(id: string, command: string, status: 'completed' | 'error' | 'running' | 'pending' = 'completed'): ToolPart {
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

  it('leaves the reasoning out by default', async () => {
    const renderer = new HistoryRenderer(send, OPTIONS);

    renderer.onReasoning('reasoning-1', 'Thinking about it', true);
    await renderer.finish();

    expect(sent).toEqual([]);
    expect(renderer.messageCount).toBe(0);
  });

  it('posts the reasoning as a quote, in order with the text', async () => {
    const renderer = new HistoryRenderer(send, { ...OPTIONS, reasoning: true });

    renderer.onReasoning('reasoning-1', 'The data looks noisy.\n\nTry a median filter.', false);
    renderer.onText('step-1', 'Applying a median filter', true);
    await renderer.finish();

    expect(sent).toEqual(['> 💭 The data looks noisy.\n> Try a median filter.', 'Applying a median filter']);
  });

  it('keeps a step that is still empty when the next one starts, and posts it once its text arrives', async () => {
    // As opencode 1.19 sends a reasoning step followed by a tool call: the step starts empty, the tool call arrives,
    // then the step's final text.
    const renderer = new HistoryRenderer(send, { ...OPTIONS, reasoning: true });

    renderer.onReasoning('reasoning-1', '', false);
    renderer.onTool(tool('tool-1', 'crunch --help', 'pending'));
    await new Promise((resolve) => setTimeout(resolve, 0)); // the events arrive one by one
    renderer.onReasoning('reasoning-1', 'Exploring the crunch tools', true);
    renderer.onTool(tool('tool-1', 'crunch --help'));
    await renderer.finish();

    expect(sent).toEqual(['> 💭 Exploring the crunch tools', '-# 🔧 **bash** `crunch --help`']);
  });

  it('posts the kinds listed in silent without a notification', async () => {
    const calls: [string, { silent: boolean }][] = [];
    const renderer = new HistoryRenderer(async (content, options) => calls.push([content, options]), {
      ...OPTIONS,
      reasoning: true,
      silent: ['reasoning', 'toolCalls'],
    });

    renderer.onReasoning('reasoning-1', 'Thinking', true);
    renderer.onTool(tool('tool-1', 'ls'));
    renderer.onText('step-1', 'Done with the setup', true);
    await renderer.finish();

    expect(calls).toEqual([
      ['> 💭 Thinking', { silent: true }],
      ['-# 🔧 **bash** `ls`', { silent: true }],
      ['Done with the setup', { silent: false }],
    ]);
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

  it('adds the arguments of a tool that takes them apart', () => {
    const part: ToolPart = { id: 'tool-1', sessionID: 'session-1', messageID: 'message-1', tool: 'pty_spawn', state: { status: 'completed', input: { command: 'sleep', args: ['120'], notifyOnExit: true } } };
    expect(describeTool(part)).toBe('-# 🔧 **pty_spawn** `sleep 120`');
  });

  it('replaces the backticks that would break the code span', () => {
    expect(describeTool(tool('tool-1', 'echo `date`'))).toBe("-# 🔧 **bash** `echo 'date'`");
  });
});

describe('describeBackgroundProcessExit', () => {
  // As sent by opencode-pty 0.4.0 (notification-manager.js).
  const notice = (exitCode: number, timedOut: string) => [
    '<pty_exited>',
    'ID: pty_1',
    'Description: crunch run wait `126296`',
    `Exit Code: ${exitCode}`,
    'TimeoutSeconds: none',
    `Timed Out: ${timedOut}`,
    'Output Lines: 12',
    'Last Line: wait: run succeeded',
    '</pty_exited>',
    '',
    'Use pty_read to check the full output.',
  ].join('\n');

  it('describes the process that ended in one line', () => {
    expect(describeBackgroundProcessExit(notice(3, 'no'))).toBe("-# 🔔 **background process ended** `crunch run wait '126296'` (exit code 3)");
  });

  it('says when the process timed out', () => {
    expect(describeBackgroundProcessExit(notice(143, 'yes'))).toContain('(exit code 143, timed out)');
  });

  it('leaves any other message alone', () => {
    expect(describeBackgroundProcessExit('Please continue')).toBeNull();
  });

  it('is used for the messages that reach the session', async () => {
    const sent: string[] = [];
    const renderer = new HistoryRenderer(async (content) => sent.push(content), OPTIONS);

    renderer.onUserMessage('user-1', notice(0, 'no'));
    await renderer.finish();

    expect(sent).toEqual(["-# 🔔 **background process ended** `crunch run wait '126296'` (exit code 0)"]);
  });
});

describe('joinLines', () => {
  it('splits the lines into messages under the length limit', () => {
    const chunks = joinLines(Array.from({ length: 30 }, () => 'x'.repeat(100)));

    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= 1900)).toBe(true);
  });
});

describe('quoteChunks', () => {
  it('keeps every chunk a valid quote, with the header only once', () => {
    const chunks = quoteChunks(Array.from({ length: 40 }, (_, index) => `line ${index} ${'x'.repeat(80)}`).join('\n'), '💭 ');

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.split('\n').every((line) => line.startsWith('> ')))).toBe(true);
    expect(chunks.join('\n').split('💭').length).toBe(2);
  });
});

describe('quote', () => {
  it('cuts a long text to fit in one message', () => {
    expect(quote('x'.repeat(5000), 'header').length).toBeLessThan(2000);
  });
});

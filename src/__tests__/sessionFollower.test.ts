import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sseClients: any[] = [];

vi.mock('../services/sseClient.js', () => ({
  SSEClient: vi.fn().mockImplementation(function (this: any) {
    this.callbacks = {} as Record<string, (...args: any[]) => void>;
    this.onPartUpdated = (callback: any) => (this.callbacks.part = callback);
    this.onReasoningUpdated = (callback: any) => (this.callbacks.reasoning = callback);
    this.onToolUpdated = (callback: any) => (this.callbacks.tool = callback);
    this.onQuestionAsked = (callback: any) => (this.callbacks.question = callback);
    this.onSessionIdle = (callback: any) => (this.callbacks.idle = callback);
    this.onSessionError = (callback: any) => (this.callbacks.error = callback);
    this.onError = (callback: any) => (this.callbacks.connectionError = callback);
    this.connect = vi.fn();
    this.disconnect = vi.fn();
    sseClients.push(this);
  }),
}));
vi.mock('../services/dataStore.js');
vi.mock('../services/serveManager.js');
vi.mock('../services/sessionManager.js');
vi.mock('../services/configStore.js');
vi.mock('../services/queueManager.js');

import { startSessionFollower, stopSessionFollower, isFollowingTurn } from '../services/sessionFollower.js';
import * as dataStore from '../services/dataStore.js';
import * as serveManager from '../services/serveManager.js';
import * as sessionManager from '../services/sessionManager.js';
import * as configStore from '../services/configStore.js';
import * as queueManager from '../services/queueManager.js';

const HISTORY = { toolCalls: true, toolCallsFlushSeconds: 30, reasoning: false, silent: [] };

function createClient() {
  const thread = {
    isTextBased: () => true,
    parentId: 'channel-1',
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
  const client = { channels: { fetch: vi.fn().mockResolvedValue(thread) } } as any;
  return { client, thread };
}

/** Lets the queued posts and the end of the turn run. */
async function settle() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe('sessionFollower', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseClients.length = 0;
    vi.mocked(configStore.getFollowExternalTurns).mockReturnValue(true);
    vi.mocked(configStore.getHistoryConfig).mockReturnValue(HISTORY);
    vi.mocked(serveManager.getAllInstances).mockReturnValue([{ key: '/workspace', port: 14097 }]);
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([
      { threadId: 'thread-1', sessionId: 'session-1', projectPath: '/workspace', port: 14097, createdAt: 0, lastUsedAt: 0 },
    ]);
    vi.mocked(sessionManager.getSseClient).mockReturnValue(undefined);
    vi.mocked(sessionManager.wasSentByBot).mockReturnValue(false);
    vi.mocked(queueManager.isBusy).mockReturnValue(false);
  });

  afterEach(() => stopSessionFollower());

  it('follows nothing when the option is off', () => {
    vi.mocked(configStore.getFollowExternalTurns).mockReturnValue(false);

    startSessionFollower(createClient().client);

    expect(sseClients).toHaveLength(0);
  });

  it('follows nothing on a port whose server this bot does not run', () => {
    vi.mocked(serveManager.getAllInstances).mockReturnValue([]);

    startSessionFollower(createClient().client);

    expect(sseClients).toHaveLength(0);
  });

  it('posts a turn started elsewhere, then runs the queue', async () => {
    const { client, thread } = createClient();
    startSessionFollower(client);
    const [sseClient] = sseClients;
    expect(sseClient.connect).toHaveBeenCalledWith('http://127.0.0.1:14097');

    sseClient.callbacks.part({ id: 'user-1', sessionID: 'session-1', messageID: 'message-1', text: 'Keep going', fromUser: true });
    sseClient.callbacks.part({ id: 'step-1', sessionID: 'session-1', messageID: 'message-2', text: 'Trying a larger model', ended: true });
    expect(isFollowingTurn('thread-1')).toBe(true);

    sseClient.callbacks.idle('session-1');
    expect(isFollowingTurn('thread-1')).toBe(false);
    await settle();

    expect(thread.send.mock.calls.map(([message]: any[]) => message.content)).toEqual([
      '> 💬 **Message to the agent:**\n> Keep going',
      'Trying a larger model',
    ]);
    expect(queueManager.processNextInQueue).toHaveBeenCalledWith(thread, 'thread-1', 'channel-1');
  });

  it('shows the typing indicator during a followed turn, and stops it when the turn ends', async () => {
    vi.useFakeTimers();
    try {
      const { client, thread } = createClient();
      startSessionFollower(client);
      const [sseClient] = sseClients;

      sseClient.callbacks.part({ id: 'step-1', sessionID: 'session-1', messageID: 'message-2', text: 'Working', ended: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(thread.sendTyping).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(thread.sendTyping).toHaveBeenCalledTimes(2);

      sseClient.callbacks.idle('session-1');
      await vi.advanceTimersByTimeAsync(16_000);
      expect(thread.sendTyping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a run started from Discord to the execution service', async () => {
    vi.mocked(sessionManager.getSseClient).mockReturnValue({ isConnected: () => true } as any);
    const { client, thread } = createClient();
    startSessionFollower(client);
    const [sseClient] = sseClients;

    sseClient.callbacks.part({ id: 'step-1', sessionID: 'session-1', messageID: 'message-2', text: 'Working', ended: true });
    sseClient.callbacks.idle('session-1');
    await settle();

    expect(isFollowingTurn('thread-1')).toBe(false);
    expect(thread.send).not.toHaveBeenCalled();
  });

  it('ignores the other sessions of the server', async () => {
    const { client, thread } = createClient();
    startSessionFollower(client);
    const [sseClient] = sseClients;

    sseClient.callbacks.part({ id: 'step-1', sessionID: 'session-2', messageID: 'message-2', text: 'Elsewhere', ended: true });
    await settle();

    expect(isFollowingTurn('thread-1')).toBe(false);
    expect(thread.send).not.toHaveBeenCalled();
  });

  it('disconnects when the session is no longer served', () => {
    vi.useFakeTimers();
    try {
      startSessionFollower(createClient().client);
      const [sseClient] = sseClients;

      vi.mocked(serveManager.getAllInstances).mockReturnValue([]);
      vi.advanceTimersByTime(15_000);

      expect(sseClient.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

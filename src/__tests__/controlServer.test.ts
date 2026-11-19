import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

vi.mock('../services/dataStore.js');
vi.mock('../services/executionService.js');
vi.mock('../utils/threadHelper.js');

import { startControlServer, requestThread } from '../services/controlServer.js';
import * as dataStore from '../services/dataStore.js';
import { runPrompt } from '../services/executionService.js';
import { createSessionThread } from '../utils/threadHelper.js';

describe('controlServer', () => {
  let server: Server;
  let port: number;
  const channel = { id: 'channel-1', threads: {} };
  const client = { user: { id: 'bot-1' }, channels: { fetch: vi.fn() } } as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    client.channels.fetch.mockResolvedValue(channel);
    vi.mocked(dataStore.getChannelProjectPath).mockImplementation((channelId) => (channelId === 'channel-1' ? '/workspace' : undefined));
    vi.mocked(createSessionThread).mockResolvedValue({ id: 'thread-1' } as any);
    vi.mocked(runPrompt).mockResolvedValue(undefined);

    server = startControlServer(client, 0);
    await new Promise((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('creates the thread and runs the prompt as /opencode does', async () => {
    const threadId = await requestThread(port, { channelId: 'channel-1', prompt: 'Take part in the competition', title: 'opus' });

    expect(threadId).toBe('thread-1');
    expect(createSessionThread).toHaveBeenCalledWith(channel, 'Take part in the competition', 'bot-1', 'opus');
    expect(runPrompt).toHaveBeenCalledWith({ id: 'thread-1' }, 'thread-1', 'Take part in the competition', 'channel-1');
  });

  it('refuses a channel bound to no project of this instance', async () => {
    await expect(requestThread(port, { channelId: 'channel-2', prompt: 'hello' })).rejects.toThrow('not bound to a project');
    expect(createSessionThread).not.toHaveBeenCalled();
  });

  it('refuses an empty prompt', async () => {
    await expect(requestThread(port, { channelId: 'channel-1', prompt: '  ' })).rejects.toThrow('non-empty `prompt`');
  });

  it('only answers POST /threads', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/other`);
    expect(response.status).toBe(404);
  });
});

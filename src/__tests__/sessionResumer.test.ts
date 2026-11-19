import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/dataStore.js');
vi.mock('../services/serveManager.js');

import { resumeSessions } from '../services/sessionResumer.js';
import * as dataStore from '../services/dataStore.js';
import * as serveManager from '../services/serveManager.js';

function session(threadId: string, projectPath: string, port: number) {
  return { threadId, sessionId: `session-${threadId}`, projectPath, port, createdAt: 1, lastUsedAt: 2 };
}

describe('resumeSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dataStore.getAllBindings).mockReturnValue([
      { channelId: 'channel-1', projectAlias: 'workspace' },
      { channelId: 'channel-2', projectAlias: 'other' },
    ]);
    vi.mocked(dataStore.getChannelProjectPath).mockImplementation((channelId) => ({ 'channel-1': '/workspace', 'channel-2': '/other' } as any)[channelId]);
    vi.mocked(dataStore.getChannelModel).mockReturnValue('');
    vi.mocked(serveManager.spawnServe).mockResolvedValue(14098);
    vi.mocked(serveManager.waitForReady).mockResolvedValue(undefined);
  });

  it('starts the server of a project with sessions, and moves its sessions to the new port', async () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([session('thread-1', '/workspace', 14097)]);

    await resumeSessions();

    expect(serveManager.spawnServe).toHaveBeenCalledTimes(1);
    expect(serveManager.spawnServe).toHaveBeenCalledWith('/workspace', undefined);
    expect(dataStore.setThreadSession).toHaveBeenCalledWith({ ...session('thread-1', '/workspace', 14097), port: 14098 });
  });

  it('leaves the sessions alone when the port did not change', async () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([session('thread-1', '/workspace', 14098)]);

    await resumeSessions();

    expect(dataStore.setThreadSession).not.toHaveBeenCalled();
  });

  it('does nothing without sessions', async () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([]);

    await resumeSessions();

    expect(serveManager.spawnServe).not.toHaveBeenCalled();
  });

  it('goes on with the other projects when a server fails to start', async () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([session('thread-1', '/workspace', 14097), session('thread-2', '/other', 14099)]);
    vi.mocked(serveManager.spawnServe).mockRejectedValueOnce(new Error('opencode not found')).mockResolvedValueOnce(14099);

    await resumeSessions();

    expect(serveManager.spawnServe).toHaveBeenCalledTimes(2);
    expect(dataStore.setThreadSession).not.toHaveBeenCalled();
  });
});

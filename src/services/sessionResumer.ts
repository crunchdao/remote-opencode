import * as dataStore from './dataStore.js';
import * as serveManager from './serveManager.js';

const READY_TIMEOUT_MS = 60_000;

/**
 * `resumeSessions`: when the bot starts, starts the opencode server of every bound project that has thread sessions,
 * as the first prompt typed in Discord would. Without it, after a restart nothing runs until someone writes in a
 * thread: a client sending prompts to a session (a script, a supervisor) finds no server, and `followExternalTurns`
 * has nothing to follow.
 *
 * A server can come back on another port: the sessions of its project are updated, keeping their last use (the order
 * of the threads does not change).
 */
export async function resumeSessions(): Promise<void> {
  const sessions = dataStore.getAllThreadSessions();
  if (!sessions.length) return;

  const ports = new Map<string, number>();
  for (const binding of dataStore.getAllBindings()) {
    const projectPath = dataStore.getChannelProjectPath(binding.channelId);
    if (!projectPath || ports.has(projectPath) || !sessions.some((session) => session.projectPath === projectPath)) continue;

    // As `runPrompt` starts it: the channel's model, if any.
    const model = dataStore.getChannelModel(binding.channelId) || undefined;
    try {
      const port = await serveManager.spawnServe(projectPath, model);
      await serveManager.waitForReady(port, READY_TIMEOUT_MS, projectPath, model);
      ports.set(projectPath, port);
      console.log(`Resumed the opencode server of ${projectPath} on port ${port}`);
    } catch (error) {
      console.error(`Could not resume the opencode server of ${projectPath}:`, error instanceof Error ? error.message : error);
    }
  }

  for (const session of sessions) {
    const port = ports.get(session.projectPath);
    if (port !== undefined && port !== session.port) {
      dataStore.setThreadSession({ ...session, port });
    }
  }
}

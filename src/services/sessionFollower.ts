import type { Client, TextBasedChannel } from 'discord.js';
import { MessageFlags } from 'discord.js';
import * as dataStore from './dataStore.js';
import * as serveManager from './serveManager.js';
import * as sessionManager from './sessionManager.js';
import { SSEClient } from './sseClient.js';
import { HistoryRenderer } from './historyRenderer.js';
import { autoAnswerPendingQuestions, autoAnswerQuestion } from './questionService.js';
import { getFollowExternalTurns, getHistoryConfig } from './configStore.js';
import { isBusy, processNextInQueue } from './queueManager.js';

const POLL_INTERVAL_MS = 15_000;

interface FollowedSession {
  threadId: string;
  sessionId: string;
  port: number;
  sseClient: SSEClient;
  /** The turn being shown, from its first event to the session going idle. */
  turn: HistoryRenderer | null;
}

// One per thread, while its session's opencode server runs.
const followed = new Map<string, FollowedSession>();
let pollTimer: NodeJS.Timeout | null = null;

/**
 * `followExternalTurns`: shows in Discord the turns that this bot did not start, like a prompt sent to the session by
 * a script or another opencode client, or a plugin's notice. The bot otherwise only listens to a session while it runs
 * a prompt typed in Discord, so whatever happens in between is never posted.
 *
 * Every thread session whose opencode server this bot runs is followed. A turn is shown in the thread, in the history
 * format, unless the bot is already showing it as a run started from Discord. Messages sent in the thread during a
 * followed turn are handled as during a run (`busyMessages`), and the queue goes on once the turn ends.
 */
export function startSessionFollower(client: Client): void {
  if (pollTimer) return;

  const poll = () => {
    try {
      syncFollowedSessions(client);
    } catch (error) {
      console.error('Session follower failed:', error instanceof Error ? error.message : error);
    }
  };

  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

export function stopSessionFollower(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  for (const threadId of [...followed.keys()]) unfollow(threadId);
}

/** Whether a turn that this bot did not start is running in the thread's session. */
export function isFollowingTurn(threadId: string): boolean {
  return !!followed.get(threadId)?.turn;
}

function syncFollowedSessions(client: Client): void {
  const enabled = getFollowExternalTurns();
  const servedPorts = new Set(serveManager.getAllInstances().map((instance) => instance.port));

  const wanted = new Map(
    enabled
      ? dataStore
          .getAllThreadSessions()
          .filter((threadSession) => servedPorts.has(threadSession.port))
          .map((threadSession) => [threadSession.threadId, threadSession])
      : [],
  );

  for (const [threadId, current] of followed) {
    const threadSession = wanted.get(threadId);
    if (!threadSession || threadSession.sessionId !== current.sessionId || threadSession.port !== current.port) {
      unfollow(threadId);
    }
  }

  for (const [threadId, threadSession] of wanted) {
    if (!followed.has(threadId)) {
      follow(client, threadId, threadSession.sessionId, threadSession.port);
    }
  }
}

function follow(client: Client, threadId: string, sessionId: string, port: number): void {
  const sseClient = new SSEClient();
  const session: FollowedSession = { threadId, sessionId, port, sseClient, turn: null };
  followed.set(threadId, session);

  // A run started from Discord is shown by the execution service.
  const isShownByRun = () => !session.turn && !!sessionManager.getSseClient(threadId)?.isConnected();

  const turn = (): HistoryRenderer => {
    if (!session.turn) {
      session.turn = new HistoryRenderer((content, options) => send(client, threadId, content, options.silent), getHistoryConfig());
      session.turn.start();
    }
    return session.turn;
  };

  sseClient.onPartUpdated((part) => {
    if (part.sessionID !== sessionId || isShownByRun()) return;

    if (part.fromUser) {
      if (!part.synthetic && !sessionManager.wasSentByBot(sessionId, part.text)) turn().onUserMessage(part.id, part.text);
      return;
    }
    turn().onText(part.id, part.text, !!part.ended);
  });

  sseClient.onReasoningUpdated((part) => {
    if (part.sessionID !== sessionId || isShownByRun()) return;
    turn().onReasoning(part.id, part.text, !!part.ended);
  });

  sseClient.onToolUpdated((part) => {
    if (part.sessionID !== sessionId || isShownByRun()) return;
    turn().onTool(part);
  });

  const postNotices = (notices: string[]) => notices.forEach((notice) => turn().onNotice(notice));
  const logQuestionError = (error: unknown) =>
    console.error('Could not answer a question:', error instanceof Error ? error.message : error);

  sseClient.onQuestionAsked((request) => {
    if (request.sessionID !== sessionId || isShownByRun()) return;
    autoAnswerQuestion(port, request)
      .then((notice) => notice && postNotices([notice]))
      .catch(logQuestionError);
  });

  const endTurn = () => {
    const ended = session.turn;
    if (!ended) return;
    session.turn = null;

    void (async () => {
      await ended.finish();

      // Messages queued during the turn run now, as after a run started from Discord.
      const channel = await fetchThread(client, threadId);
      const parentChannelId = channel && 'parentId' in channel ? channel.parentId : null;
      if (channel && parentChannelId && !isBusy(threadId)) {
        await processNextInQueue(channel, threadId, parentChannelId);
      }
    })().catch((error) => console.error('Could not end a followed turn:', error instanceof Error ? error.message : error));
  };

  sseClient.onSessionIdle((idleSessionId) => {
    if (idleSessionId === sessionId) endTurn();
  });

  sseClient.onSessionError((errorSessionId, error) => {
    if (errorSessionId !== sessionId || !session.turn) return;
    const message = error.data?.message || error.name || 'Unknown error';
    send(client, threadId, `❌ **Error**: ${message}`, false)
      .catch((sendError) => console.error('Could not post a session error:', sendError instanceof Error ? sendError.message : sendError));
    endTurn();
  });

  // Reconnected at the next poll.
  sseClient.onError(() => unfollow(threadId));

  sseClient.connect(`http://127.0.0.1:${port}`);

  // A question asked before the session was followed has no event left to come.
  autoAnswerPendingQuestions(port, sessionId).then(postNotices).catch(logQuestionError);
}

function unfollow(threadId: string): void {
  const session = followed.get(threadId);
  if (!session) return;

  followed.delete(threadId);
  session.sseClient.disconnect();
  void session.turn?.finish();
}

async function fetchThread(client: Client, threadId: string): Promise<TextBasedChannel | null> {
  try {
    const channel = await client.channels.fetch(threadId);
    return channel?.isTextBased() ? channel : null;
  } catch {
    return null;
  }
}

async function send(client: Client, threadId: string, content: string, silent: boolean): Promise<void> {
  const channel = await fetchThread(client, threadId);
  if (!channel || !('send' in channel)) return;

  await channel.send(silent ? { content, flags: MessageFlags.SuppressNotifications } : { content });
}

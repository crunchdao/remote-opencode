import type { ChildProcess } from 'node:child_process';

export interface ProjectConfig {
  alias: string;
  path: string;
  autoWorktree?: boolean;
  autoPassthrough?: boolean;
}

export interface ChannelBinding {
  channelId: string;
  projectAlias: string;
  model?: string;
}

export interface DataStore {
  projects: ProjectConfig[];
  bindings: ChannelBinding[];
  threadSessions?: ThreadSession[];
  worktreeMappings?: WorktreeMapping[];
  passthroughThreads?: PassthroughThread[];
  queues?: Record<string, QueuedMessage[]>;
  queueSettings?: Record<string, QueueSettings>;
}

export interface QueuedMessage {
  prompt: string;
  userId: string;
  timestamp: number;
  voiceAttachmentUrl?: string;
  voiceAttachmentSize?: number;
}

export interface QueueSettings {
  paused: boolean;
  continueOnFailure: boolean;
  freshContext: boolean;
}


export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  text: string;
  /** The step is complete (opencode set its end time). */
  ended?: boolean;
  /** The part belongs to a message of the user, not of the agent. */
  fromUser?: boolean;
  /** Added by opencode itself (for example, the content of an attached file), not typed by anyone. */
  synthetic?: boolean;
}

export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  tool: string;
  state?: {
    status?: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
  };
}

export interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface ServeInstance {
  port: number;
  process: ChildProcess;
  startTime: number;
  exited?: boolean;
  exitCode?: number | null;
  exitError?: string;
}

export interface ThreadSession {
  threadId: string;
  sessionId: string;
  projectPath: string;
  port: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface WorktreeMapping {
  threadId: string;
  branchName: string;
  worktreePath: string;
  projectPath: string;
  description: string;
  createdAt: number;
}

export interface PassthroughThread {
  threadId: string;
  enabled: boolean;
  enabledBy: string;  // userId
  enabledAt: number;
}

export interface SessionErrorInfo {
  name: 'ProviderAuthError' | 'UnknownError' | 'MessageOutputLengthError' | 'MessageAbortedError';
  data: {
    message?: string;
    providerID?: string;
  };
}

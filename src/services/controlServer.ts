import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Client, TextChannel } from 'discord.js';
import * as dataStore from './dataStore.js';
import { runPrompt } from './executionService.js';
import { createSessionThread } from '../utils/threadHelper.js';

const MAX_BODY_BYTES = 256 * 1024;

export interface StartThreadRequest {
  channelId: string;
  prompt: string;
  title?: string;
}

/**
 * `controlPort`: a local HTTP endpoint (127.0.0.1 only) through which the command line starts a session as `/opencode`
 * would, for scripts that drive the bot (`remote-opencode start-thread`):
 *
 *   POST /threads  {"channelId": "...", "prompt": "...", "title": "..."}  =>  201 {"threadId": "..."}
 *
 * The thread is created in the channel, and the prompt runs there exactly like a prompt typed with `/opencode`.
 */
export function startControlServer(client: Client, port: number): Server {
  const server = createServer((request, response) => {
    handle(client, request, response).catch((error) => {
      reply(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Control endpoint listening on 127.0.0.1:${port}`);
  });
  return server;
}

async function handle(client: Client, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/threads') {
    reply(response, 404, { error: 'Not found: the endpoint is POST /threads' });
    return;
  }

  let body: StartThreadRequest;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    reply(response, 400, { error: `Invalid JSON body: ${error instanceof Error ? error.message : error}` });
    return;
  }

  const { channelId, prompt, title } = body ?? ({} as StartThreadRequest);
  if (typeof channelId !== 'string' || typeof prompt !== 'string' || !prompt.trim()) {
    reply(response, 400, { error: '`channelId` and a non-empty `prompt` are required' });
    return;
  }
  if (!dataStore.getChannelProjectPath(channelId)) {
    reply(response, 404, { error: `Channel ${channelId} is not bound to a project of this instance` });
    return;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !('threads' in channel)) {
    reply(response, 400, { error: `Channel ${channelId} cannot hold threads` });
    return;
  }

  const thread = await createSessionThread(channel as TextChannel, prompt, client.user?.id ?? 'control', title);
  reply(response, 201, { threadId: thread.id });

  // As `/opencode` does; the run goes on after the response.
  runPrompt(thread as any, thread.id, prompt, channelId).catch((error) => {
    console.error('Run started from the control endpoint failed:', error instanceof Error ? error.message : error);
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body larger than ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    request.on('error', reject);
  });
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Starts a session through a running bot's control endpoint (the `start-thread` command). */
export async function requestThread(port: number, request: StartThreadRequest): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = (await response.json().catch(() => ({}))) as { threadId?: string; error?: string };
  if (!response.ok || !body.threadId) {
    throw new Error(body.error ?? `the bot answered ${response.status}`);
  }
  return body.threadId;
}

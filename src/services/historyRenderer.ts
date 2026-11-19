import type { ToolPart } from '../types/index.js';
import type { HistoryConfig, HistoryMessageKind } from './configStore.js';
import { formatOutputForMobile } from '../utils/messageFormatter.js';

/** Posts one message in the thread; a silent one notifies nobody (Discord's `@silent`). */
export type SendMessage = (content: string, options: { silent: boolean }) => Promise<unknown>;

// Discord accepts 2000 characters per message; the margin leaves room for the markdown added around the text.
const MESSAGE_LIMIT = 1900;
const TOOL_SUBJECT_LIMIT = 160;

type StepKind = 'text' | 'reasoning';

/**
 * `outputMode: history`: posts a run as it goes, one message per finished step of the agent, in order, and its tool
 * calls as compact lines between them. Nothing is edited afterwards, so the whole run stays readable in the thread.
 *
 * Steps are posted once complete, or as soon as a later step starts (a step is never updated after that). Tool call
 * lines are batched: posted every `toolCallsFlushSeconds`, and before the next step.
 */
export class HistoryRenderer {
  private readonly steps = new Map<string, { kind: StepKind; text: string }>();
  private readonly posted = new Set<string>();
  private toolLines: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;
  private postedCount = 0;

  constructor(
    private readonly send: SendMessage,
    private readonly options: HistoryConfig,
  ) {}

  start(): void {
    if (this.options.toolCalls && !this.flushTimer) {
      this.flushTimer = setInterval(() => this.enqueue(() => this.flushToolLines()), this.options.toolCallsFlushSeconds * 1000);
    }
  }

  /** A text step of the agent changed; `ended` once it is complete. */
  onText(id: string, text: string, ended: boolean): void {
    this.updateStep(id, 'text', text, ended);
  }

  /** A reasoning step changed: posted as a 💭 quote, when `reasoning` is on. */
  onReasoning(id: string, text: string, ended: boolean): void {
    if (!this.options.reasoning) return;
    this.updateStep(id, 'reasoning', text, ended);
  }

  onTool(part: ToolPart): void {
    this.postStepsBefore(null);

    const status = part.state?.status;
    if (!this.options.toolCalls || (status !== 'completed' && status !== 'error') || this.posted.has(part.id)) return;

    this.posted.add(part.id);
    // Queued too, so the line lands after the steps posted before it.
    const line = describeTool(part);
    this.enqueue(async () => {
      this.toolLines.push(line);
    });
  }

  /**
   * A message reached the session from elsewhere than this thread: it is quoted where the agent received it, or shown
   * as one line when it is a notice that a background process ended.
   */
  onUserMessage(id: string, text: string): void {
    if (this.posted.has(id) || !text.trim()) return;

    this.posted.add(id);
    this.postStepsBefore(null);
    this.enqueue(async () => {
      await this.flushToolLines();
      const notice = describeBackgroundProcessExit(text);
      await (notice ? this.post(notice, 'notices') : this.post(quote(text, '💬 **Message to the agent:**'), 'messages'));
    });
  }

  /** A one-line notice, posted in order with the steps. */
  onNotice(text: string): void {
    this.postStepsBefore(null);
    this.enqueue(async () => {
      await this.flushToolLines();
      await this.post(text, 'notices');
    });
  }

  /** Posts everything left, in order, and stops the periodic posting of tool call lines. */
  async finish(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.postStepsBefore(null);
    this.enqueue(() => this.flushToolLines());
    await this.chain;
  }

  /** How many messages were posted so far. */
  get messageCount(): number {
    return this.postedCount;
  }

  private updateStep(id: string, kind: StepKind, text: string, ended: boolean): void {
    if (this.posted.has(id)) return;

    // A new step: the previous ones are complete.
    if (!this.steps.has(id)) this.postStepsBefore(id);

    this.steps.set(id, { kind, text });
    if (ended) this.enqueue(() => this.postStep(id));
  }

  private postStepsBefore(exceptId: string | null): void {
    for (const id of this.steps.keys()) {
      if (id !== exceptId) this.enqueue(() => this.postStep(id));
    }
  }

  private async postStep(id: string): Promise<void> {
    const step = this.steps.get(id);
    const text = step?.text.trim();

    // A step can still be empty when the next one starts (opencode sends a reasoning step's text only at its end,
    // after the tool call that follows it has started): it stays pending until its text arrives.
    if (this.posted.has(id) || !step || !text) return;

    this.posted.add(id);
    this.steps.delete(id);

    await this.flushToolLines();
    const chunks = step.kind === 'reasoning' ? quoteChunks(text, '💭 ') : formatOutputForMobile(text).chunks;
    for (const chunk of chunks) {
      await this.post(chunk, step.kind);
    }
  }

  private async flushToolLines(): Promise<void> {
    const lines = this.toolLines;
    this.toolLines = [];

    for (const chunk of joinLines(lines)) {
      await this.post(chunk, 'toolCalls');
    }
  }

  private async post(content: string, kind: HistoryMessageKind): Promise<void> {
    await this.send(content, { silent: this.options.silent.includes(kind) });
    this.postedCount++;
  }

  /** Posting is sequential, so the messages keep the order of the steps. */
  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain
      .then(task)
      .catch((error) => console.error('Could not post a step of the run:', error instanceof Error ? error.message : error));
  }
}

/** One subtext line (`-# `), so tool calls stand apart from the agent's own words. */
export function describeTool(part: ToolPart): string {
  const input = part.state?.input ?? {};
  const base = input.command ?? input.filePath ?? input.url ?? input.pattern ?? input.path;
  // Some tools take the command's arguments apart (opencode-pty's `pty_spawn`: `command` and `args`).
  const subject = base === undefined
    ? JSON.stringify(input)
    : Array.isArray(input.args) && input.args.length ? `${base} ${input.args.join(' ')}` : base;
  const oneLine = String(subject).replace(/\s+/g, ' ').trim();
  const shortened = oneLine.length > TOOL_SUBJECT_LIMIT ? `${oneLine.slice(0, TOOL_SUBJECT_LIMIT)}…` : oneLine;
  const icon = part.state?.status === 'error' ? '❌' : '🔧';

  return `-# ${icon} **${part.tool}** \`${shortened.replace(/`/g, "'")}\``;
}

/**
 * One subtext line for the message the opencode-pty plugin sends to the session when a background process ends
 * (`<pty_exited>`, then `Field: value` lines), or null for any other message.
 */
export function describeBackgroundProcessExit(text: string): string | null {
  if (!text.trimStart().startsWith('<pty_exited>')) return null;

  const field = (name: string) => text.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1]?.trim() ?? '?';
  const timedOut = field('Timed Out') === 'yes' ? ', timed out' : '';

  // The same shape as the tool call lines: a bold label, then its subject.
  return `-# 🔔 **background process ended** \`${field('Description').replace(/`/g, "'")}\` (exit code ${field('Exit Code')}${timedOut})`;
}

/** Lines joined into as few messages as the length limit allows. */
export function joinLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let chunk = '';

  for (const line of lines) {
    if (chunk && chunk.length + line.length + 1 > MESSAGE_LIMIT) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk = chunk ? `${chunk}\n${line}` : line;
  }

  if (chunk) chunks.push(chunk);
  return chunks;
}

/** The whole text as block quotes, split on line boundaries so that every message stays a valid quote. */
export function quoteChunks(text: string, header: string): string[] {
  const lines = text
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => line.match(/[\s\S]{1,1800}/g) ?? []);

  return joinLines(lines.map((line, index) => `> ${index === 0 ? header : ''}${line}`));
}

/** The text as a block quote, with the header on its first line, cut to fit in one message. */
export function quote(text: string, header: string): string {
  const trimmed = text.trim();
  const shortened = trimmed.length > MESSAGE_LIMIT - header.length ? `${trimmed.slice(0, MESSAGE_LIMIT - header.length)}…` : trimmed;

  return [`> ${header}`, ...shortened.split('\n').map((line) => `> ${line}`)].join('\n');
}

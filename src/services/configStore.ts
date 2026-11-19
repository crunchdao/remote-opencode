import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface BotConfig {
  discordToken: string;
  clientId: string;
  guildId: string;
}

export interface PortConfig {
  min: number;
  max: number;
}

export interface AppConfig {
  bot?: BotConfig;
  ports?: PortConfig;
  allowedUserIds?: string[];
  openaiApiKey?: string;
  /**
   * Answer slash commands and buttons only in the channels bound to one of this instance's projects (and in their
   * threads), and stay silent elsewhere. For several instances sharing one Discord bot, each bound to its own channels.
   */
  ignoreUnboundChannels?: boolean;
  /**
   * What happens to a message sent in a thread while its session is working: `queue` runs it after the current run
   * ends, `interrupt` delivers it to the running session right away (the agent reads it at its next step).
   */
  busyMessages?: BusyMessagesMode;
  /**
   * How a run is shown: `live` rewrites one message with the latest output, `history` posts every step of the agent as
   * its own message, so the whole run stays readable afterwards.
   */
  outputMode?: OutputMode;
  history?: Partial<HistoryConfig>;
  /**
   * Also show the turns this bot did not start (a prompt sent to the session by a script or another opencode client,
   * a plugin's notice), in the history format, as long as the bot runs the session's opencode server.
   */
  followExternalTurns?: boolean;
  /**
   * opencode's `question` tool waits for an answer that the bot never shows, so an agent that asks one is stuck. When
   * set, every question gets this text as its answer, and a notice is posted in the thread.
   */
  autoAnswerQuestions?: string;
  /**
   * Port of a local HTTP endpoint (127.0.0.1 only) through which `remote-opencode start-thread` starts a session as
   * `/opencode` would. Unset: no endpoint.
   */
  controlPort?: number;
  /**
   * When the bot starts, start the opencode server of every bound project that has thread sessions, as their first
   * prompt would: clients sending prompts to these sessions (scripts) find their server after a restart.
   */
  resumeSessions?: boolean;
}

export type BusyMessagesMode = 'queue' | 'interrupt';

export type OutputMode = 'live' | 'history';

export interface HistoryConfig {
  /** Post the agent's tool calls, one line each, batched. */
  toolCalls: boolean;
  /** How often the batched tool call lines are posted, in seconds (they are also posted before the next step). */
  toolCallsFlushSeconds: number;
  /** Post the agent's reasoning steps, as quotes, for the models that expose them. */
  reasoning: boolean;
  /** The kinds of messages posted as `@silent`: they appear in the thread, without a notification. */
  silent: HistoryMessageKind[];
}

/**
 * `text` and `reasoning` steps, `toolCalls` lines, `messages` (quoted messages to the agent) and `notices` (one-line
 * notices, like a background process that ended).
 */
export type HistoryMessageKind = 'text' | 'reasoning' | 'toolCalls' | 'messages' | 'notices';

const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
  toolCalls: true,
  toolCallsFlushSeconds: 30,
  reasoning: false,
  silent: [],
};

const CONFIG_DIR = join(homedir(), '.remote-opencode');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): AppConfig {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as AppConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: AppConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function getBotConfig(): BotConfig | undefined {
  return loadConfig().bot;
}

export function setBotConfig(bot: BotConfig): void {
  const config = loadConfig();
  config.bot = bot;
  saveConfig(config);
}

export function getPortConfig(): PortConfig | undefined {
  return loadConfig().ports;
}

export function setPortConfig(ports: PortConfig): void {
  const config = loadConfig();
  config.ports = ports;
  saveConfig(config);
}

export function hasBotConfig(): boolean {
  const bot = getBotConfig();
  return !!(bot?.discordToken && bot?.clientId && bot?.guildId);
}

export function clearBotConfig(): void {
  const config = loadConfig();
  delete config.bot;
  saveConfig(config);
}

export function getAllowedUserIds(): string[] {
  return loadConfig().allowedUserIds ?? [];
}

export function setAllowedUserIds(ids: string[]): void {
  const config = loadConfig();
  config.allowedUserIds = ids;
  saveConfig(config);
}

export function addAllowedUserId(id: string): void {
  const config = loadConfig();
  const current = config.allowedUserIds ?? [];
  if (!current.includes(id)) {
    config.allowedUserIds = [...current, id];
    saveConfig(config);
  }
}

export function removeAllowedUserId(id: string): boolean {
  const config = loadConfig();
  const current = config.allowedUserIds ?? [];
  if (!current.includes(id)) return false;
  if (current.length <= 1) return false; // prevent removing last user
  config.allowedUserIds = current.filter(uid => uid !== id);
  saveConfig(config);
  return true;
}

export function isAuthorized(userId: string): boolean {
  const ids = getAllowedUserIds();
  if (ids.length === 0) return true; // no restriction
  return ids.includes(userId);
}

export function getIgnoreUnboundChannels(): boolean {
  return loadConfig().ignoreUnboundChannels ?? false;
}

export function getBusyMessagesMode(): BusyMessagesMode {
  return loadConfig().busyMessages === 'interrupt' ? 'interrupt' : 'queue';
}

export function getOutputMode(): OutputMode {
  return loadConfig().outputMode === 'history' ? 'history' : 'live';
}

export function getHistoryConfig(): HistoryConfig {
  const config = { ...DEFAULT_HISTORY_CONFIG, ...loadConfig().history };

  // A hand-written config.json can hold anything: fall back to the defaults rather than crash a run.
  if (!Array.isArray(config.silent)) config.silent = DEFAULT_HISTORY_CONFIG.silent;
  if (!(config.toolCallsFlushSeconds > 0)) config.toolCallsFlushSeconds = DEFAULT_HISTORY_CONFIG.toolCallsFlushSeconds;

  return config;
}

export function getFollowExternalTurns(): boolean {
  return loadConfig().followExternalTurns ?? false;
}

export function getAutoAnswerQuestions(): string | null {
  const answer = loadConfig().autoAnswerQuestions;
  return typeof answer === 'string' && answer.trim() ? answer.trim() : null;
}

export function getControlPort(): number | null {
  const port = loadConfig().controlPort;
  return Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536 ? (port as number) : null;
}

export function getResumeSessions(): boolean {
  return loadConfig().resumeSessions ?? false;
}

/** The behavior options (README, "Behavior options") with their effective values, defaults included. */
export function getBehaviorOptions(): Record<string, unknown> {
  return {
    ignoreUnboundChannels: getIgnoreUnboundChannels(),
    busyMessages: getBusyMessagesMode(),
    outputMode: getOutputMode(),
    history: getHistoryConfig(),
    followExternalTurns: getFollowExternalTurns(),
    autoAnswerQuestions: getAutoAnswerQuestions(),
    controlPort: getControlPort(),
    resumeSessions: getResumeSessions(),
  };
}

export function getOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY || loadConfig().openaiApiKey;
}

export function setOpenAIApiKey(key: string): void {
  const config = loadConfig();
  config.openaiApiKey = key;
  saveConfig(config);
}

export function removeOpenAIApiKey(): void {
  const config = loadConfig();
  delete config.openaiApiKey;
  saveConfig(config);
}

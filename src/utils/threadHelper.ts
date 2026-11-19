import { ChatInputCommandInteraction, ThreadAutoArchiveDuration, TextChannel, ThreadChannel } from 'discord.js';
import * as dataStore from '../services/dataStore.js';

export async function getOrCreateThread(
  interaction: ChatInputCommandInteraction,
  prompt: string
): Promise<ThreadChannel> {
  const channel = interaction.channel;

  if (channel?.isThread()) {
    return channel;
  }

  if (channel && 'threads' in channel) {
    return createSessionThread(channel as TextChannel, prompt, interaction.user.id);
  }

  throw new Error('Cannot create thread in this channel.');
}

/**
 * Creates the thread of a new session in a channel bound to a project, named after its prompt (or `title`), with
 * passthrough on when the project has `autoPassthrough`.
 */
export async function createSessionThread(
  channel: TextChannel,
  prompt: string,
  userId: string,
  title?: string
): Promise<ThreadChannel> {
  const name = title ?? prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');
  const thread = await channel.threads.create({
    name: `🤖 ${name}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: 'OpenCode session'
  });

  const alias = dataStore.getChannelBinding(channel.id);
  if (alias && dataStore.getProjectAutoPassthrough(alias)) {
    dataStore.setPassthroughMode(thread.id, true, userId);
  }

  return thread;
}

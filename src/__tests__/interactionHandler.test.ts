import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/configStore.js');
vi.mock('../services/dataStore.js');
vi.mock('../handlers/buttonHandler.js');
vi.mock('../commands/index.js', () => ({ commands: new Map() }));

import { handleInteraction } from '../handlers/interactionHandler.js';
import * as configStore from '../services/configStore.js';
import * as dataStore from '../services/dataStore.js';
import { handleButton } from '../handlers/buttonHandler.js';

function createButtonInteraction(channel: { isThread: () => boolean; parentId?: string }, channelId: string) {
  return {
    isButton: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    channel,
    channelId,
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('interactionHandler - ignoreUnboundChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configStore.isAuthorized).mockReturnValue(true);
    vi.mocked(dataStore.getChannelBinding).mockImplementation((channelId) => (channelId === 'bound' ? 'project' : undefined));
  });

  it('handles every channel by default', async () => {
    vi.mocked(configStore.getIgnoreUnboundChannels).mockReturnValue(false);

    await handleInteraction(createButtonInteraction({ isThread: () => false }, 'other'));

    expect(handleButton).toHaveBeenCalledTimes(1);
  });

  it('ignores a channel bound to no project', async () => {
    vi.mocked(configStore.getIgnoreUnboundChannels).mockReturnValue(true);
    const interaction = createButtonInteraction({ isThread: () => false }, 'other');

    await handleInteraction(interaction);

    expect(handleButton).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('handles a bound channel and the threads inside it', async () => {
    vi.mocked(configStore.getIgnoreUnboundChannels).mockReturnValue(true);

    await handleInteraction(createButtonInteraction({ isThread: () => false }, 'bound'));
    await handleInteraction(createButtonInteraction({ isThread: () => true, parentId: 'bound' }, 'thread-1'));

    expect(handleButton).toHaveBeenCalledTimes(2);
  });

  it('ignores a thread inside an unbound channel', async () => {
    vi.mocked(configStore.getIgnoreUnboundChannels).mockReturnValue(true);

    await handleInteraction(createButtonInteraction({ isThread: () => true, parentId: 'other' }, 'thread-1'));

    expect(handleButton).not.toHaveBeenCalled();
  });
});

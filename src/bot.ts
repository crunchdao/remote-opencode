import { Client, GatewayIntentBits, Events } from 'discord.js';
import pc from 'picocolors';
import { getBotConfig, getControlPort, getResumeSessions } from './services/configStore.js';
import { resumeSessions } from './services/sessionResumer.js';
import { startControlServer } from './services/controlServer.js';
import { handleInteraction } from './handlers/interactionHandler.js';
import { handleMessageCreate } from './handlers/messageHandler.js';
import * as serveManager from './services/serveManager.js';
import { initializeProxySupport } from './services/proxySupport.js';
import { getCachedModels } from './commands/model.js';
import { startSessionFollower, stopSessionFollower } from './services/sessionFollower.js';

export async function startBot(): Promise<void> {
  const config = getBotConfig();
  
  if (!config) {
    throw new Error('Bot configuration not found. Run setup first.');
  }
  
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, 
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });
  
  client.once(Events.ClientReady, (c) => {
    console.log(pc.green(`Ready! Logged in as ${pc.bold(c.user.tag)}`));
    // Pre-warm model cache so autocomplete never hits cold execSync
    try { getCachedModels(); } catch { }
    // Checks `followExternalTurns` at every poll, so turning it on or off applies without a restart.
    startSessionFollower(c);

    const controlPort = getControlPort();
    if (controlPort !== null) startControlServer(c, controlPort);

    if (getResumeSessions()) {
      resumeSessions().catch((error) => console.error('Could not resume the sessions:', error instanceof Error ? error.message : error));
    }
  });
  
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.MessageCreate, handleMessageCreate);
  
  function gracefulShutdown(signal: string) {
    console.log(pc.yellow(`\n${signal} received. Shutting down gracefully...`));
    
    stopSessionFollower();
    serveManager.stopAll();
    console.log(pc.dim('All opencode serve instances stopped.'));
    
    client.destroy();
    console.log(pc.dim('Discord client destroyed.'));
    
    process.exit(0);
  }
  
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  
  initializeProxySupport();
  console.log(pc.dim('Connecting to Discord...'));
  await client.login(config.discordToken);
}

/**
 * AcmeAsk — entry point.
 * Starts Slack Bolt app in Socket Mode + HTTP server for OAuth callbacks.
 */
import { slackApp } from './slack/app';
import { startOAuthServer } from './oauth-server';
import { logger } from './middleware/logger';
import { config } from './config';

async function main() {
  try {
    // Start OAuth callback HTTP server
    await startOAuthServer(config.PORT);
    logger.info({ port: config.PORT }, 'OAuth callback server started');

    // Start Slack app (Socket Mode)
    await slackApp.start();
    logger.info('AcmeAsk Slack bot started in Socket Mode');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start AcmeAsk');
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  await slackApp.stop();
  process.exit(0);
});

main();

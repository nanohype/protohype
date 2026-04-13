/**
 * Lightweight HTTP server for OAuth callback handling.
 * Handles redirect URIs from Notion, Confluence, and Google after authorization.
 */
import * as http from 'http';
import * as url from 'url';
import { consumeOAuthState, handleNotionCallback, handleConfluenceCallback, handleGoogleCallback } from './auth/oauth-flow';
import { logger } from './middleware/logger';

export function startOAuthServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url) {
        res.writeHead(400).end('Bad request');
        return;
      }

      const parsed = url.parse(req.url, true);
      const { pathname, query } = parsed;

      const code = query.code as string | undefined;
      const state = query.state as string | undefined;

      if (!code || !state) {
        res.writeHead(400).end('Missing code or state');
        return;
      }

      const stateData = consumeOAuthState(state);
      if (!stateData) {
        res.writeHead(400).end('Invalid or expired state');
        return;
      }

      const { oktaUserId, slackUserId } = stateData;

      try {
        if (pathname === '/oauth/notion/callback') {
          await handleNotionCallback(code, oktaUserId, slackUserId);
          res.writeHead(200).end('<h1>Notion connected! Return to Slack.</h1>');
        } else if (pathname === '/oauth/confluence/callback') {
          await handleConfluenceCallback(code, oktaUserId, slackUserId);
          res.writeHead(200).end('<h1>Confluence connected! Return to Slack.</h1>');
        } else if (pathname === '/oauth/google/callback') {
          await handleGoogleCallback(code, oktaUserId, slackUserId);
          res.writeHead(200).end('<h1>Google Drive connected! Return to Slack.</h1>');
        } else {
          res.writeHead(404).end('Not found');
        }
      } catch (err) {
        logger.error({ err, pathname, oktaUserId }, 'OAuth callback error');
        res.writeHead(500).end('Authorization failed. Please try again.');
      }
    });

    server.listen(port, () => resolve());
  });
}

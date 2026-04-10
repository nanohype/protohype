/**
 * Server registry — maps route paths to (credentials → McpServer) factories.
 * The Lambda handler imports this to resolve which server to instantiate.
 */

export { createHubSpotServer } from './hubspot.js';
export { createGDriveServer } from './gdrive.js';
export { createGCalServer } from './gcal.js';
export { createAnalyticsServer } from './analytics.js';
export { createGCSEServer } from './gcse.js';
export { createStripeServer } from './stripe.js';

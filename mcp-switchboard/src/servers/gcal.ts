/**
 * Google Calendar MCP server.
 * Uses a service account with domain-wide delegation (impersonateEmail required).
 * Tools: list calendars, list/get/create/update/delete events.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { google, calendar_v3 } from 'googleapis';
import { z } from 'zod';
import { GoogleSACredentials } from '../auth.js';

function buildCalendarClient(creds: GoogleSACredentials): calendar_v3.Calendar {
  const auth = new google.auth.JWT({
    email: (creds.serviceAccountKey as { client_email: string }).client_email,
    key: (creds.serviceAccountKey as { private_key: string }).private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
    subject: creds.impersonateEmail,
  });
  return google.calendar({ version: 'v3', auth });
}

export function createGCalServer(creds: GoogleSACredentials): McpServer {
  const cal = buildCalendarClient(creds);
  const server = new McpServer({ name: 'mcp-gcal', version: '0.1.0' });

  server.tool(
    'gcal_list_calendars',
    'List all calendars accessible to the service account.',
    {},
    async () => {
      const res = await cal.calendarList.list({
        fields: 'items(id, summary, description, timeZone, accessRole)',
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'gcal_list_events',
    'List events from a calendar within a time range.',
    {
      calendarId: z.string().default('primary').describe('Calendar ID. Use "primary" for the main calendar.'),
      timeMin: z.string().describe('Start of range in ISO 8601 format (e.g., 2025-01-01T00:00:00Z)'),
      timeMax: z.string().describe('End of range in ISO 8601 format'),
      maxResults: z.number().int().min(1).max(250).default(25).describe('Max events to return'),
      query: z.string().optional().describe('Free-text search query to filter events'),
      pageToken: z.string().optional().describe('Pagination token'),
    },
    async ({ calendarId, timeMin, timeMax, maxResults, query, pageToken }) => {
      const res = await cal.events.list({
        calendarId,
        timeMin,
        timeMax,
        maxResults,
        q: query,
        pageToken,
        singleEvents: true,
        orderBy: 'startTime',
        fields: 'nextPageToken, items(id, summary, description, start, end, location, attendees, status, htmlLink)',
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'gcal_get_event',
    'Get details of a specific calendar event.',
    {
      calendarId: z.string().default('primary').describe('Calendar ID'),
      eventId: z.string().describe('Event ID'),
    },
    async ({ calendarId, eventId }) => {
      const res = await cal.events.get({ calendarId, eventId });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'gcal_create_event',
    'Create a new calendar event.',
    {
      calendarId: z.string().default('primary').describe('Calendar ID'),
      summary: z.string().describe('Event title'),
      description: z.string().optional().describe('Event description'),
      location: z.string().optional().describe('Physical or virtual location'),
      startDateTime: z.string().describe('Start date/time in ISO 8601 (e.g., 2025-02-01T10:00:00-08:00)'),
      endDateTime: z.string().describe('End date/time in ISO 8601'),
      timeZone: z.string().default('UTC').describe('IANA timezone (e.g., America/Los_Angeles)'),
      attendeeEmails: z.array(z.string().email()).optional().describe('Email addresses to invite'),
    },
    async ({ calendarId, summary, description, location, startDateTime, endDateTime, timeZone, attendeeEmails }) => {
      const event: calendar_v3.Schema$Event = {
        summary,
        description,
        location,
        start: { dateTime: startDateTime, timeZone },
        end: { dateTime: endDateTime, timeZone },
        attendees: attendeeEmails?.map(email => ({ email })),
      };
      const res = await cal.events.insert({ calendarId, requestBody: event, sendUpdates: 'all' });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'gcal_update_event',
    'Update an existing calendar event.',
    {
      calendarId: z.string().default('primary').describe('Calendar ID'),
      eventId: z.string().describe('Event ID to update'),
      summary: z.string().optional().describe('New event title'),
      description: z.string().optional().describe('New description'),
      location: z.string().optional().describe('New location'),
      startDateTime: z.string().optional().describe('New start date/time in ISO 8601'),
      endDateTime: z.string().optional().describe('New end date/time in ISO 8601'),
      timeZone: z.string().optional().describe('IANA timezone'),
    },
    async ({ calendarId, eventId, summary, description, location, startDateTime, endDateTime, timeZone }) => {
      // Patch only provided fields
      const patch: calendar_v3.Schema$Event = {};
      if (summary !== undefined) patch.summary = summary;
      if (description !== undefined) patch.description = description;
      if (location !== undefined) patch.location = location;
      if (startDateTime !== undefined) patch.start = { dateTime: startDateTime, timeZone };
      if (endDateTime !== undefined) patch.end = { dateTime: endDateTime, timeZone };

      const res = await cal.events.patch({ calendarId, eventId, requestBody: patch, sendUpdates: 'all' });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'gcal_delete_event',
    'Delete a calendar event.',
    {
      calendarId: z.string().default('primary').describe('Calendar ID'),
      eventId: z.string().describe('Event ID to delete'),
    },
    async ({ calendarId, eventId }) => {
      await cal.events.delete({ calendarId, eventId, sendUpdates: 'all' });
      return { content: [{ type: 'text', text: `Event ${eventId} deleted from calendar ${calendarId}` }] };
    }
  );

  return server;
}

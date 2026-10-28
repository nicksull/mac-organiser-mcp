#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCalendar } from './calendar.js';
import { loadConfig } from './config.js';
import { registerNotes } from './notes.js';
import { registerReminders } from './reminders.js';

const config = loadConfig();
const server = new McpServer({ name: 'mac-organiser-mcp', version: '0.2.0' });

if (config.apps.has('reminders')) registerReminders(server, config.reminders);
if (config.apps.has('calendar')) registerCalendar(server, config.calendar);
if (config.apps.has('notes')) registerNotes(server, config.notes);

await server.connect(new StdioServerTransport());

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { localIso, runJxa, toolResult, UNTRUSTED } from './osascript.js';

// Visibility rules (list allowlist, notes) are enforced here, inside the Reminders
// process, so filtered-out data never reaches Node at all.
const SCRIPT = String.raw`
function handle(req) {
  var app = Application('Reminders');
  var allowed = req.allowed;

  function visible(name) { return !allowed || allowed.indexOf(name) !== -1; }

  // Without this, a misspelt allowlist looks exactly like having no reminders.
  // The error names only the configured lists, never the ones that exist.
  function visibleLists() {
    var lists = app.lists().filter(function (l) { return visible(l.name()); });
    if (allowed && !lists.length) {
      throw new Error('REMINDERS_LISTS (' + allowed.join(', ') + ') matches none of your Reminders lists. ' +
        'Names must match exactly, including capitalisation.');
    }
    return lists;
  }

  function findList(name) {
    var matches = visibleLists().filter(function (l) { return l.name() === name; });
    if (!matches.length) throw new Error('List not found: ' + name);
    return matches[0];
  }

  function findReminder(id) {
    var r = app.reminders.byId(id);
    var listName;
    try { listName = r.container().name(); } catch (e) { throw new Error('Reminder not found'); }
    if (!visible(listName)) throw new Error('Reminder not found');
    return r;
  }

  function ms(d) { return d ? d.getTime() : null; }

  function collect(lists, filter, includeNotes, limit) {
    var out = [];
    for (var i = 0; i < lists.length && out.length < limit; i++) {
      var listName = lists[i].name();
      var rs = filter ? lists[i].reminders.whose(filter) : lists[i].reminders;
      var ids = rs.id();
      if (!ids.length) continue;
      var names = rs.name(), done = rs.completed(), due = rs.dueDate(), prio = rs.priority();
      var bodies = includeNotes ? rs.body() : null;
      for (var j = 0; j < ids.length && out.length < limit; j++) {
        var item = {
          id: ids[j], name: names[j], list: listName, completed: done[j],
          dueDate: ms(due[j]), priority: prio[j]
        };
        if (includeNotes) item.notes = bodies[j] || null;
        out.push(item);
      }
    }
    return out;
  }

  function scope(listName) { return listName ? [findList(listName)] : visibleLists(); }

  switch (req.op) {
    case 'lists':
      return visibleLists().map(function (l) { return l.name(); });

    case 'get': {
      var f = req.completed === undefined ? null : { completed: req.completed };
      return collect(scope(req.listName), f, req.includeNotes, req.limit);
    }

    case 'search': {
      var t = { _contains: req.query };
      var cond = req.includeNotes ? { _or: [{ name: t }, { body: t }] } : { name: t };
      if (req.completed !== undefined) cond = { _and: [cond, { completed: req.completed }] };
      return collect(scope(req.listName), cond, req.includeNotes, req.limit);
    }

    case 'create': {
      var props = { name: req.name };
      if (req.notes !== undefined) props.body = req.notes;
      if (req.dueDate !== undefined) props.dueDate = new Date(req.dueDate);
      if (req.priority !== undefined) props.priority = req.priority;
      var r = app.Reminder(props);
      findList(req.listName).reminders.push(r);
      return { id: r.id() };
    }

    case 'update': {
      var u = findReminder(req.id);
      if (req.name !== undefined) u.name = req.name;
      if (req.notes !== undefined) u.body = req.notes;
      if (typeof req.dueDate === 'number') u.dueDate = new Date(req.dueDate);
      if (req.priority !== undefined) u.priority = req.priority;
      if (req.completed !== undefined) u.completed = req.completed;
      if (req.dueDate === null) clearDueDate(req.id);
      return { id: req.id };
    }

    case 'delete':
      app.delete(findReminder(req.id));
      return { id: req.id };

    default:
      throw new Error('Unknown op');
  }
}

// Reminders' scripting interface cannot remove a due date (it has no way to
// express "missing value" from JXA, and AppleScript refuses it), so this one
// change goes through EventKit. The caller has already checked the allowlist.
function clearDueDate(id) {
  ObjC.import('EventKit');
  var status = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeReminder));
  if (status === 0) {
    var done = false;
    $.EKEventStore.alloc.init.requestFullAccessToRemindersWithCompletion(function () { done = true; });
    var until = Date.now() + 40000;
    while (!done && Date.now() < until) {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
    }
    status = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeReminder));
  }
  if (status !== 3) {
    throw new Error('Clearing a due date needs full Reminders access in System Settings > Privacy & Security > Reminders.');
  }

  var store = $.EKEventStore.alloc.init;
  var items = store.calendarItemsWithExternalIdentifier(id.replace('x-apple-reminder://', ''));
  var r = null;
  for (var i = 0; items && !items.isNil() && i < items.count; i++) {
    if (items.objectAtIndex(i).isKindOfClass($.EKReminder)) r = items.objectAtIndex(i);
  }
  if (!r) throw new Error('Reminder not found');

  // Reminders attaches its alert to the due date, so it goes too. $() is nil;
  // JS null would bridge to NSNull, which EventKit rejects.
  r.dueDateComponents = $();
  r.startDateComponents = $();
  r.alarms = $();
  var err = $();
  if (!store.saveReminderCommitError(r, true, err)) {
    throw new Error('Reminders refused the change: ' + ObjC.unwrap(err.localizedDescription));
  }
}
`;

const listName = z.string().min(1).max(200);
const reminderId = z
  .string()
  .regex(/^x-apple-reminder:\/\/[A-Za-z0-9-]{1,64}$/, 'Expected an x-apple-reminder:// ID');
const title = z.string().min(1).max(500);
const notes = z.string().max(5000);
const dueDate = z.iso
  .datetime({ local: true, offset: true })
  .describe('ISO 8601, e.g. 2026-10-29T14:00 (local time) or 2026-10-29T14:00+11:00');
const priority = z
  .union([z.literal(0), z.literal(1), z.literal(5), z.literal(9)])
  .describe('0 = none, 1 = high, 5 = medium, 9 = low');

interface ReminderItem {
  dueDate: number | null;
}

export function registerReminders(server: McpServer, config: AppConfig) {
  const run = <T>(req: Record<string, unknown>) => runJxa<T>(SCRIPT, { ...req, allowed: config.allowed }, 'Reminders');

  const readItems = async (req: Record<string, unknown>) => {
    const items = await run<ReminderItem[]>(req);
    return items.map((r) => ({ ...r, dueDate: localIso(r.dueDate) }));
  };

  const limit = z.number().int().min(1).max(config.maxResults).optional();
  // Only exposed when notes are enabled; readParams() enforces the setting regardless.
  const includeNotes = (
    config.allowDetails
      ? { includeNotes: z.boolean().optional().describe('Include reminder notes (default false)') }
      : {}
  ) as { includeNotes: z.ZodOptional<z.ZodBoolean> };

  const readParams = (args: { includeNotes?: boolean; limit?: number }) => ({
    includeNotes: config.allowDetails && args.includeNotes === true,
    limit: args.limit ?? config.maxResults,
  });

  // Parsed in Node so local-time strings are interpreted consistently.
  const toMs = (v: string | null | undefined) => (v == null ? v : new Date(v).getTime());

  server.registerTool(
    'list_reminder_lists',
    {
      description: 'List the names of the Reminders lists this server can access.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => toolResult(run({ op: 'lists' }))
  );

  server.registerTool(
    'get_reminders',
    {
      description: `Get reminders, incomplete only by default. ${UNTRUSTED}`,
      inputSchema: {
        listName: listName.optional(),
        completed: z.boolean().optional().describe('Defaults to false (incomplete only)'),
        limit,
        ...includeNotes,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      toolResult(readItems({ op: 'get', ...readParams(args), listName: args.listName, completed: args.completed ?? false }))
  );

  server.registerTool(
    'search_reminders',
    {
      description: `Search reminders by name (and notes, if enabled). Case-insensitive. ${UNTRUSTED}`,
      inputSchema: {
        query: z.string().min(1).max(200),
        listName: listName.optional(),
        completed: z.boolean().optional().describe('Omit to search both'),
        limit,
        ...includeNotes,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      toolResult(
        readItems({ op: 'search', ...readParams(args), query: args.query, listName: args.listName, completed: args.completed })
      )
  );

  if (config.readOnly) return;

  server.registerTool(
    'create_reminder',
    {
      description: 'Create a reminder in a list.',
      inputSchema: { name: title, listName, notes: notes.optional(), dueDate: dueDate.optional(), priority: priority.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => toolResult(run({ op: 'create', ...args, dueDate: toMs(args.dueDate) }))
  );

  server.registerTool(
    'update_reminder',
    {
      description: 'Update a reminder. Pass dueDate: null to clear the due date.',
      inputSchema: {
        id: reminderId,
        name: title.optional(),
        notes: notes.optional(),
        dueDate: dueDate.nullable().optional(),
        priority: priority.optional(),
        completed: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => toolResult(run({ op: 'update', ...args, dueDate: toMs(args.dueDate) }))
  );

  if (!config.allowDelete) return;

  server.registerTool(
    'delete_reminder',
    {
      description: 'Permanently delete a reminder. Prefer completing it instead.',
      inputSchema: { id: reminderId },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args) => toolResult(run({ op: 'delete', id: args.id }))
  );
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { AppError, localIso, runJxa, toolResult, UNTRUSTED } from './osascript.js';

// Uses EventKit via the JXA ObjC bridge rather than scripting Calendar.app: it is
// much faster and expands recurring events into real occurrences. The calendar
// allowlist is enforced here, so hidden calendars never reach Node.
const SCRIPT = String.raw`
ObjC.import('EventKit');

function handle(req) {
  var store = access();
  var allowed = req.allowed;

  function s(x) {
    if (x === undefined || x === null || (x.isNil && x.isNil())) return null;
    var v = ObjC.unwrap(x);
    return v === undefined || v === null ? null : String(v);
  }
  function toNs(ms) { return $.NSDate.dateWithTimeIntervalSince1970(ms / 1000); }
  function toMs(d) { return d && !d.isNil() ? Math.round(d.timeIntervalSince1970 * 1000) : null; }
  function each(arr, fn) { for (var i = 0; i < arr.count; i++) fn(arr.objectAtIndex(i)); }

  function visible(c) {
    return !allowed || allowed.indexOf(s(c.title)) !== -1 || allowed.indexOf(s(c.calendarIdentifier)) !== -1;
  }

  function calendars() {
    var out = [];
    each(store.calendarsForEntityType($.EKEntityTypeEvent), function (c) { if (visible(c)) out.push(c); });
    return out;
  }

  function findCalendar(key) {
    var matches = calendars().filter(function (c) { return s(c.calendarIdentifier) === key || s(c.title) === key; });
    if (!matches.length) throw new Error('Calendar not found: ' + key);
    if (matches.length > 1) throw new Error('Several calendars are named "' + key + '"; pass its id instead');
    return matches[0];
  }

  function info(e) {
    var o = {
      id: s(e.eventIdentifier), title: s(e.title), start: toMs(e.startDate), end: toMs(e.endDate),
      allDay: !!e.allDay, calendar: s(e.calendar.title), recurring: !!e.hasRecurrenceRules
    };
    if (req.includeDetails) {
      o.location = s(e.location);
      o.notes = s(e.notes);
      o.url = e.URL && !e.URL.isNil() ? s(e.URL.absoluteString) : null;
    }
    return o;
  }

  function query(cals, start, end) {
    var out = [];
    if (!cals.length) return out;
    var pred = store.predicateForEventsWithStartDateEndDateCalendars(toNs(start), toNs(end), $(cals));
    each(store.eventsMatchingPredicate(pred), function (e) { out.push(e); });
    return out;
  }

  // Recurring events share one identifier, so a single occurrence is located by
  // its start time. Changes only ever apply to that occurrence, never the series.
  function findEvent(id, occurrenceStart) {
    var e = store.eventWithIdentifier(id);
    if (!e || e.isNil() || !visible(e.calendar)) throw new Error('Event not found');
    if (!e.hasRecurrenceRules) return e;
    if (occurrenceStart === undefined) {
      throw new Error('This is a recurring event: pass occurrenceStart (its start from get_events) to change one occurrence');
    }
    var day = 86400000;
    var hits = query([e.calendar], occurrenceStart - day, occurrenceStart + day).filter(function (o) {
      return s(o.eventIdentifier) === id && toMs(o.startDate) === occurrenceStart;
    });
    if (!hits.length) throw new Error('Occurrence not found');
    return hits[0];
  }

  // Changing an event with attendees makes the server email the invitees, so
  // those are left to Calendar.app where the user sees that happen.
  function writable(e) {
    if (!e.calendar.allowsContentModifications) throw new Error('Calendar is read-only');
    if (e.hasAttendees) throw new Error('Event has attendees; edit it in Calendar so invitees are not notified unexpectedly');
    return e;
  }

  function check(ok, err) {
    if (!ok) throw new Error('Calendar refused the change: ' + (s(err.localizedDescription) || 'unknown error'));
  }

  function apply(e, r) {
    if (r.title !== undefined) e.title = r.title;
    if (r.start !== undefined) e.startDate = toNs(r.start);
    if (r.end !== undefined) e.endDate = toNs(r.end);
    if (r.allDay !== undefined) e.allDay = r.allDay;
    if (r.location !== undefined) e.location = r.location;
    if (r.notes !== undefined) e.notes = r.notes;
  }

  switch (req.op) {
    case 'calendars':
      return calendars().map(function (c) {
        return { name: s(c.title), id: s(c.calendarIdentifier), account: s(c.source.title), writable: !!c.allowsContentModifications };
      });

    case 'events': {
      var q = req.query ? req.query.toLowerCase() : null;
      var events = query(req.calendar ? [findCalendar(req.calendar)] : calendars(), req.start, req.end)
        .filter(function (e) { return !q || (s(e.title) || '').toLowerCase().indexOf(q) !== -1; })
        .map(info)
        .sort(function (a, b) { return a.start - b.start; });
      return { events: events.slice(0, req.limit), truncated: events.length > req.limit };
    }

    case 'create': {
      var cal = findCalendar(req.calendar);
      if (!cal.allowsContentModifications) throw new Error('Calendar is read-only');
      var e = $.EKEvent.eventWithEventStore(store);
      e.calendar = cal;
      apply(e, req);
      var err = $();
      check(store.saveEventSpanCommitError(e, $.EKSpanThisEvent, true, err), err);
      return { id: s(e.eventIdentifier) };
    }

    case 'update': {
      var u = writable(findEvent(req.id, req.occurrenceStart));
      apply(u, req);
      var uerr = $();
      check(store.saveEventSpanCommitError(u, $.EKSpanThisEvent, true, uerr), uerr);
      return { id: req.id };
    }

    case 'delete': {
      var d = writable(findEvent(req.id, req.occurrenceStart));
      var derr = $();
      check(store.removeEventSpanCommitError(d, $.EKSpanThisEvent, true, derr), derr);
      return { id: req.id };
    }

    default:
      throw new Error('Unknown op');
  }
}

function access() {
  var status = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent));
  if (status === 3) return $.EKEventStore.alloc.init;
  if (status === 0) {
    var done = false, granted = false;
    $.EKEventStore.alloc.init.requestFullAccessToEventsWithCompletion(function (g) { granted = !!g; done = true; });
    var until = Date.now() + 40000;
    while (!done && Date.now() < until) {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
    }
    if (granted) return $.EKEventStore.alloc.init;
  }
  throw new Error('Not authorised to read calendars. Allow full access in System Settings > Privacy & Security > Calendars.');
}
`;

const DAY = 86_400_000;

// Date-only values mean local midnight; datetimes without an offset mean local time.
const when = z
  .union([z.iso.date(), z.iso.datetime({ local: true, offset: true })])
  .describe('ISO 8601: 2026-10-29, 2026-10-29T14:00 (local time) or 2026-10-29T14:00+11:00');

function toMs(v: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : new Date(v).getTime();
}

const eventId = z.string().min(1).max(512).regex(/^[^\u0000-\u001f]+$/);
const calendarKey = z.string().min(1).max(200).describe('Calendar name or id (from list_calendars)');
const occurrenceStart = when.optional().describe('For recurring events: the occurrence start from get_events');
const title = z.string().min(1).max(500);
const location = z.string().max(500);
const notes = z.string().max(5000);

interface EventItem {
  start: number | null;
  end: number | null;
}

export function registerCalendar(server: McpServer, config: AppConfig) {
  const run = <T>(req: Record<string, unknown>) => runJxa<T>(SCRIPT, { ...req, allowed: config.allowed }, 'Calendar');

  const includeDetails = (
    config.allowDetails
      ? { includeDetails: z.boolean().optional().describe('Include location, notes and URL (default false)') }
      : {}
  ) as { includeDetails: z.ZodOptional<z.ZodBoolean> };

  server.registerTool(
    'list_calendars',
    {
      description: 'List the calendars this server can access.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => toolResult(run({ op: 'calendars' }))
  );

  server.registerTool(
    'get_events',
    {
      description:
        `Get events between two times (recurring events are expanded into occurrences). ` +
        `Attendees are never returned. ${UNTRUSTED}`,
      inputSchema: {
        start: when,
        end: when.optional().describe('Defaults to 7 days after start; at most 366 days after start'),
        calendar: calendarKey.optional(),
        query: z.string().min(1).max(200).optional().describe('Case-insensitive match on the title'),
        limit: z.number().int().min(1).max(config.maxResults).optional(),
        ...includeDetails,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const start = toMs(args.start);
      const end = args.end ? toMs(args.end) : start + 7 * DAY;
      if (end <= start || end - start > 366 * DAY) {
        return toolResult(Promise.reject(new AppError('end must be after start and within 366 days of it')));
      }
      return toolResult(
        run<{ events: EventItem[]; truncated: boolean }>({
          op: 'events',
          start,
          end,
          calendar: args.calendar,
          query: args.query,
          limit: args.limit ?? config.maxResults,
          includeDetails: config.allowDetails && args.includeDetails === true,
        }).then((r) => ({ ...r, events: r.events.map((e) => ({ ...e, start: localIso(e.start), end: localIso(e.end) })) }))
      );
    }
  );

  if (config.readOnly) return;

  server.registerTool(
    'create_event',
    {
      description: 'Create an event (no attendees, so no invitations are sent).',
      inputSchema: {
        calendar: calendarKey,
        title,
        start: when,
        end: when.optional().describe('Defaults to 1 hour after start (or start, for all-day events)'),
        allDay: z.boolean().optional(),
        location: location.optional(),
        notes: notes.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const start = toMs(args.start);
      const end = args.end ? toMs(args.end) : args.allDay ? start : start + 3_600_000;
      if (end < start) return toolResult(Promise.reject(new AppError('end must not be before start')));
      return toolResult(run({ op: 'create', ...args, start, end }));
    }
  );

  server.registerTool(
    'update_event',
    {
      description:
        'Update an event. For a recurring event this changes only the given occurrence. ' +
        'Events with attendees cannot be changed here.',
      inputSchema: {
        id: eventId,
        occurrenceStart,
        title: title.optional(),
        start: when.optional(),
        end: when.optional(),
        allDay: z.boolean().optional(),
        location: location.optional(),
        notes: notes.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      toolResult(
        run({
          op: 'update',
          ...args,
          occurrenceStart: args.occurrenceStart && toMs(args.occurrenceStart),
          start: args.start && toMs(args.start),
          end: args.end && toMs(args.end),
        })
      )
  );

  if (!config.allowDelete) return;

  server.registerTool(
    'delete_event',
    {
      description:
        'Permanently delete an event. For a recurring event this deletes only the given occurrence. ' +
        'Events with attendees cannot be deleted here.',
      inputSchema: { id: eventId, occurrenceStart },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args) =>
      toolResult(run({ op: 'delete', id: args.id, occurrenceStart: args.occurrenceStart && toMs(args.occurrenceStart) }))
  );
}

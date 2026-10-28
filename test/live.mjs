// Live end-to-end test against real Reminders, Calendar and Notes. It creates an
// "MCP Test" list, calendar and folder, locks every allowlist to them, runs every
// tool, then deletes them. None of your other data is read.
// Usage: npm run build && npm run test:live
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const T = 'MCP Test';
const FIXTURES = fileURLToPath(new URL('./fixtures.js', import.meta.url));
const fixtures = (mode) =>
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', FIXTURES, mode], { encoding: 'utf8' }).trim();

console.log('setup:', fixtures('setup'));
process.on('exit', () => console.log('teardown:', fixtures('teardown')));

const c = new Client({ name: 'e2e', version: '0' });
await c.connect(new StdioClientTransport({
  command: 'node',
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: {
    ...process.env,
    MAC_ORGANISER_APPS: 'reminders,calendar,notes',
    REMINDERS_LISTS: T, CALENDAR_CALENDARS: T, NOTES_FOLDERS: T,
    REMINDERS_ALLOW_DELETE: '1', REMINDERS_ALLOW_NOTES: '1',
    CALENDAR_ALLOW_DELETE: '1', CALENDAR_ALLOW_DETAILS: '1',
  },
}));

let pass = 0, fail = 0;
async function call(name, args = {}) {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = r.content[0].text;
  if (r.isError) return { error: text };
  return JSON.parse(text);
}
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ok  ', label); }
  else { fail++; console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)); }
}
function jxa(src, ...args) {
  return execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', src, ...args], { encoding: 'utf8' }).trim();
}
const pad = (n) => String(n).padStart(2, '0');
const tomorrow = new Date(Date.now() + 86_400_000);
const day = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

console.log('Reminders');
const evil = `Call Mum's dentist'; touch PWNED; #" & (do shell script "touch PWNED2") & "`;
const cr = await call('create_reminder', { name: evil, listName: T, notes: 'secret note', dueDate: `${day}T14:00`, priority: 1 });
check('create', cr.id?.startsWith('x-apple-reminder://'), cr);
let rs = await call('get_reminders', {});
check('get finds it with exact name', rs.length === 1 && rs[0].name === evil, rs);
check('due date round-trips as local time', rs[0]?.dueDate?.startsWith(`${day}T14:00:00`), rs[0]?.dueDate);
check('notes hidden by default', rs[0] && !('notes' in rs[0]), rs[0]);
rs = await call('get_reminders', { includeNotes: true });
check('notes returned on request', rs[0]?.notes === 'secret note', rs[0]);
rs = await call('search_reminders', { query: "mum's" });
check('search is case-insensitive', rs.length === 1, rs);
rs = await call('search_reminders', { query: 'secret' });
check('search skips notes unless asked', rs.length === 0, rs);
rs = await call('search_reminders', { query: 'secret', includeNotes: true });
check('search matches notes when asked', rs.length === 1, rs);
let r = await call('update_reminder', { id: cr.id, completed: true, dueDate: null, priority: 5 });
check('update', !r.error, r);
rs = await call('get_reminders', {});
check('completed hidden by default', rs.length === 0, rs);
rs = await call('get_reminders', { completed: true });
check('update applied (completed, due cleared, priority)', rs[0]?.completed && rs[0]?.dueDate === null && rs[0]?.priority === 5, rs);
r = await call('update_reminder', { id: 'x-apple-reminder://00000000-0000-0000-0000-000000000000', name: 'x' });
check('unknown/hidden reminder is "not found"', /not found/i.test(r.error ?? ''), r);
r = await call('create_reminder', { name: 'x', listName: 'Reminders' });
check('cannot create outside allowlist', /not found/i.test(r.error ?? ''), r);
r = await call('delete_reminder', { id: cr.id });
check('delete', !r.error, r);
rs = await call('get_reminders', { completed: true });
check('deleted', rs.length === 0, rs);

console.log('Calendar');
const cals = await call('list_calendars');
check('only MCP Test visible, writable', cals.length === 1 && cals[0].name === T && cals[0].writable, cals);
const ev = await call('create_event', { calendar: T, title: 'Timed <b>event</b>', start: `${day}T14:00`, location: 'Office', notes: 'agenda' });
check('create timed', ev.id, ev);
const ad = await call('create_event', { calendar: T, title: 'All day', start: day, allDay: true });
check('create all-day', ad.id, ad);
let es = await call('get_events', { start: day, end: `${day}T23:59` });
check('get finds both', es.events?.length === 2, es);
const timed = es.events?.find((e) => e.id === ev.id);
check('default 1h duration, local times', timed?.start?.startsWith(`${day}T14:00:00`) && timed?.end?.startsWith(`${day}T15:00:00`), timed);
check('details hidden by default', timed && !('location' in timed), timed);
es = await call('get_events', { start: day, query: 'TIMED', includeDetails: true });
check('query + details', es.events?.length === 1 && es.events[0].location === 'Office' && es.events[0].notes === 'agenda', es);
r = await call('update_event', { id: ev.id, title: 'Moved', start: `${day}T16:00`, end: `${day}T16:30` });
check('update', !r.error, r);
es = await call('get_events', { start: day, query: 'Moved' });
check('update applied', es.events?.[0]?.start?.startsWith(`${day}T16:00:00`) && es.events[0].end.startsWith(`${day}T16:30:00`), es);
r = await call('get_events', { start: `${day}T10:00`, end: `${day}T09:00` });
check('rejects end before start', /end must be after start/.test(r.error ?? ''), r);

// Recurring event: EventKit only, since create_event deliberately has no recurrence.
const recId = jxa(String.raw`ObjC.import('EventKit');
function run(argv) {
  var s = $.EKEventStore.alloc.init, cal;
  var all = s.calendarsForEntityType($.EKEntityTypeEvent);
  for (var i = 0; i < all.count; i++) if (ObjC.unwrap(all.objectAtIndex(i).title) === argv[0]) cal = all.objectAtIndex(i);
  var e = $.EKEvent.eventWithEventStore(s);
  e.calendar = cal; e.title = 'Standup';
  e.startDate = $.NSDate.dateWithTimeIntervalSince1970(Number(argv[1]) / 1000);
  e.endDate = $.NSDate.dateWithTimeIntervalSince1970(Number(argv[1]) / 1000 + 900);
  e.addRecurrenceRule($.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalEnd($.EKRecurrenceFrequencyDaily, 1, $.EKRecurrenceEnd.recurrenceEndWithOccurrenceCount(3)));
  var err = $(); s.saveEventSpanCommitError(e, $.EKSpanThisEvent, true, err);
  return ObjC.unwrap(e.eventIdentifier);
}`, T, String(new Date(`${day}T09:00`).getTime()));
const after3 = new Date(tomorrow.getTime() + 4 * 86_400_000);
const end4 = `${after3.getFullYear()}-${pad(after3.getMonth() + 1)}-${pad(after3.getDate())}`;
es = await call('get_events', { start: day, end: end4, query: 'standup' });
check('recurring expanded into 3 occurrences', es.events?.length === 3 && es.events.every((e) => e.recurring && e.id === recId), es);
r = await call('update_event', { id: recId, title: 'Nope' });
check('recurring update needs occurrenceStart', /occurrenceStart/.test(r.error ?? ''), r);
const second = es.events?.[1]?.start;
r = await call('update_event', { id: recId, occurrenceStart: second, title: 'Standup (moved)' });
check('update one occurrence', !r.error, r);
es = await call('get_events', { start: day, end: end4, query: 'standup' });
check('only that occurrence changed', es.events?.filter((e) => e.title === 'Standup (moved)').length === 1 && es.events.length === 3, es.events?.map((e) => e.title));
r = await call('delete_event', { id: recId, occurrenceStart: es.events?.[2]?.start });
check('delete one occurrence', !r.error, r);
es = await call('get_events', { start: day, end: end4, query: 'standup' });
check('series keeps other occurrences', es.events?.length === 2, es.events?.map((e) => e.start));
r = await call('delete_event', { id: ev.id });
check('delete event', !r.error, r);
r = await call('update_event', { id: 'NOT-A-REAL-EVENT-ID', title: 'x' });
check('unknown event is "not found"', /not found/i.test(r.error ?? ''), r);

console.log('Notes');
const folders = await call('list_note_folders');
check('only MCP Test visible', folders.length === 1 && folders[0].name === T, folders);
const html = '<img src="https://example.com/track.png"> & <b>bold</b>';
const n = await call('create_note', { folder: T, title: 'Test note', text: `line one\n${html}` });
check('create', n.id?.startsWith('x-coredata://'), n);
let ns = await call('find_notes', {});
check('find lists it', ns.notes?.length === 1 && ns.notes[0].title === 'Test note', ns);
ns = await call('find_notes', { query: 'line one' });
check('find matches body text', ns.notes?.length === 1, ns);
let g = await call('get_note', { id: n.id });
check('markup stored as literal text', g.text?.includes(html), g.text);
r = await call('append_to_note', { id: n.id, text: 'appended line' });
check('append', !r.error, r);
g = await call('get_note', { id: n.id });
check('append applied, earlier text kept', g.text?.includes('line one') && g.text.trimEnd().endsWith('appended line'), g.text);
const listNoteId = jxa(String.raw`function run(argv) {
  var app = Application('Notes');
  var f = app.folders.whose({ name: argv[0] })()[0];
  var n = app.Note({ body: '<div><h1>Checklist</h1></div><ul><li>one</li><li>two</li></ul>' });
  f.notes.push(n);
  return n.id();
}`, T);
r = await call('append_to_note', { id: listNoteId, text: 'x' });
check('append refuses notes with lists', /lists, tables or images/.test(r.error ?? ''), r);
r = await call('get_note', { id: 'x-coredata://00000000-0000-0000-0000-000000000000/ICNote/p999999' });
check('unknown/hidden note is "not found"', /not found/i.test(r.error ?? ''), r);
r = await call('create_note', { folder: 'Notes', title: 'x' });
check('cannot create outside allowlist', /not found/i.test(r.error ?? ''), r);

await c.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

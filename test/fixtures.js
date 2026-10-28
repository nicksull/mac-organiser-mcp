// Creates or removes the "MCP Test" reminders list, calendar and notes folder.
// Usage: osascript -l JavaScript fixtures.js setup|teardown
ObjC.import('EventKit');
var NAME = 'MCP Test';

function run(argv) {
  var mode = argv[0];
  var out = {};
  var rem = Application('Reminders');
  var notes = Application('Notes');
  var store = $.EKEventStore.alloc.init;

  var cals = [];
  var all = store.calendarsForEntityType($.EKEntityTypeEvent);
  for (var i = 0; i < all.count; i++) {
    if (ObjC.unwrap(all.objectAtIndex(i).title) === NAME) cals.push(all.objectAtIndex(i));
  }

  if (mode === 'setup') {
    // Never adopt an existing "MCP Test": teardown deletes everything in it.
    if (rem.lists.whose({ name: NAME })().length || notes.folders.whose({ name: NAME })().length || cals.length) {
      throw new Error('"' + NAME + '" already exists in Reminders, Calendar or Notes; remove or rename it first');
    }
    rem.lists.push(rem.List({ name: NAME }));
    notes.folders.push(notes.Folder({ name: NAME }));
    var cal = $.EKCalendar.calendarForEntityTypeEventStore($.EKEntityTypeEvent, store);
    cal.title = NAME;
    cal.source = store.defaultCalendarForNewEvents.source;
    var err = $();
    out.calendar = store.saveCalendarCommitError(cal, true, err) ? 'created in ' + ObjC.unwrap(cal.source.title) : 'failed: ' + ObjC.unwrap(err.localizedDescription);
    out.reminders = rem.lists.whose({ name: NAME })().length;
    out.notes = notes.folders.whose({ name: NAME })().length;
  } else if (mode === 'teardown') {
    var lists = rem.lists.whose({ name: NAME })();
    lists.forEach(function (l) { rem.delete(l); });
    var folders = notes.folders.whose({ name: NAME })();
    folders.forEach(function (f) {
      f.notes().forEach(function (n) { notes.delete(n); });
      notes.delete(f);
    });
    out.notesLeft = notes.folders.whose({ name: NAME })().length;
    cals.forEach(function (c) { var e = $(); store.removeCalendarCommitError(c, true, e); });
    out.removed = { reminders: lists.length, notes: folders.length, calendars: cals.length };
  }
  return JSON.stringify(out);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { localIso, runJxa, toolResult, UNTRUSTED } from './osascript.js';

// Notes has no public framework, so this scripts Notes.app. The folder allowlist
// is enforced here, so hidden notes never reach Node. Text is always written as
// escaped HTML, so nothing passed in can add markup, links or remote images.
const SCRIPT = String.raw`
function handle(req) {
  var app = Application('Notes');
  var allowed = req.allowed;

  function visible(name) {
    if (name === 'Recently Deleted') return false;
    return !allowed || allowed.indexOf(name) !== -1;
  }

  function visibleFolders() {
    return app.folders().filter(function (f) { return visible(f.name()); });
  }

  function findFolder(name) {
    var matches = visibleFolders().filter(function (f) { return f.name() === name; });
    if (!matches.length) throw new Error('Folder not found: ' + name);
    if (matches.length > 1) throw new Error('Several folders are named "' + name + '"; rename one in Notes');
    return matches[0];
  }

  function findNote(id) {
    var n = app.notes.byId(id);
    var folder;
    try { folder = n.container().name(); } catch (e) { throw new Error('Note not found'); }
    if (!visible(folder)) throw new Error('Note not found');
    return { note: n, folder: folder };
  }

  function esc(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function paragraphs(text) {
    return text.split(/\r?\n/).map(function (line) {
      return '<div>' + (line ? esc(line) : '<br>') + '</div>';
    }).join('');
  }

  // Appending rewrites the whole body, which can lose attachments and rich
  // formatting such as checklists and tables, so only plain notes are touched.
  function appendable(n, body) {
    if (n.passwordProtected()) throw new Error('Note is locked');
    if (n.attachments().length) throw new Error('Note has attachments; edit it in Notes');
    if (/<(ul|ol|table|img|object)\b/i.test(body)) throw new Error('Note has lists, tables or images; edit it in Notes');
  }

  switch (req.op) {
    case 'folders':
      return visibleFolders().map(function (f) {
        var account = null;
        try { account = f.container().name(); } catch (e) {}
        return { name: f.name(), account: account };
      });

    case 'find': {
      var folders = req.folder ? [findFolder(req.folder)] : visibleFolders();
      var t = req.query ? { _contains: req.query } : null;
      var out = [];
      folders.forEach(function (f) {
        var ns = t ? f.notes.whose({ _or: [{ name: t }, { plaintext: t }] }) : f.notes;
        var ids = ns.id();
        if (!ids.length) return;
        var names = ns.name(), mods = ns.modificationDate(), locked = ns.passwordProtected();
        for (var i = 0; i < ids.length; i++) {
          out.push({ id: ids[i], title: names[i], folder: f.name(), modified: mods[i].getTime(), locked: locked[i] });
        }
      });
      out.sort(function (a, b) { return b.modified - a.modified; });
      return { notes: out.slice(0, req.limit), truncated: out.length > req.limit };
    }

    case 'get': {
      var g = findNote(req.id);
      if (g.note.passwordProtected()) throw new Error('Note is locked');
      var text = g.note.plaintext();
      return {
        id: req.id, title: g.note.name(), folder: g.folder, modified: g.note.modificationDate().getTime(),
        text: text.slice(0, req.maxChars), truncated: text.length > req.maxChars,
        attachments: g.note.attachments().length
      };
    }

    case 'create': {
      var folder = findFolder(req.folder);
      var note = app.Note({ body: '<div><h1>' + esc(req.title) + '</h1></div>' + (req.text ? paragraphs(req.text) : '') });
      folder.notes.push(note);
      return { id: note.id() };
    }

    case 'append': {
      var a = findNote(req.id).note;
      var body = a.body();
      appendable(a, body);
      a.body = body + paragraphs(req.text);
      return { id: req.id };
    }

    default:
      throw new Error('Unknown op');
  }
}
`;

const folder = z.string().min(1).max(200);
const noteId = z
  .string()
  .regex(/^x-coredata:\/\/[A-Za-z0-9-]{1,64}\/ICNote\/p\d{1,12}$/, 'Expected an x-coredata://…/ICNote/p… ID');
const text = z.string().max(20_000);

interface NoteMeta {
  modified: number;
}

export function registerNotes(server: McpServer, config: AppConfig & { maxChars: number }) {
  const run = <T>(req: Record<string, unknown>) => runJxa<T>(SCRIPT, { ...req, allowed: config.allowed }, 'Notes');

  server.registerTool(
    'list_note_folders',
    {
      description: 'List the Notes folders this server can access.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => toolResult(run({ op: 'folders' }))
  );

  server.registerTool(
    'find_notes',
    {
      description: `List notes (newest first), optionally matching a query in the title or text. Returns titles only; use get_note for content. ${UNTRUSTED}`,
      inputSchema: {
        query: z.string().min(1).max(200).optional(),
        folder: folder.optional(),
        limit: z.number().int().min(1).max(config.maxResults).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      toolResult(
        run<{ notes: NoteMeta[]; truncated: boolean }>({
          op: 'find',
          query: args.query,
          folder: args.folder,
          limit: args.limit ?? config.maxResults,
        }).then((r) => ({ ...r, notes: r.notes.map((n) => ({ ...n, modified: localIso(n.modified) })) }))
      )
  );

  server.registerTool(
    'get_note',
    {
      description: `Read a note's text. Locked notes cannot be read. ${UNTRUSTED}`,
      inputSchema: { id: noteId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      toolResult(
        run<NoteMeta>({ op: 'get', id: args.id, maxChars: config.maxChars }).then((n) => ({
          ...n,
          modified: localIso(n.modified),
        }))
      )
  );

  if (config.readOnly) return;

  server.registerTool(
    'create_note',
    {
      description: 'Create a plain-text note in a folder.',
      inputSchema: { folder, title: z.string().min(1).max(500), text: text.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => toolResult(run({ op: 'create', ...args }))
  );

  server.registerTool(
    'append_to_note',
    {
      description:
        'Append plain text to the end of a note. Refuses locked notes and notes with attachments, lists, tables or images.',
      inputSchema: { id: noteId, text: text.min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => toolResult(run({ op: 'append', ...args }))
  );
}

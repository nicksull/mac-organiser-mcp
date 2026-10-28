export type App = 'reminders' | 'calendar' | 'notes';

export interface AppConfig {
  // null means every collection is visible.
  allowed: string[] | null;
  readOnly: boolean;
  allowDelete: boolean;
  allowDetails: boolean;
  maxResults: number;
}

export interface Config {
  apps: Set<App>;
  reminders: AppConfig;
  calendar: AppConfig;
  notes: AppConfig & { maxChars: number };
}

function flag(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name] ?? '');
}

function int(name: string, fallback: number, max: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function csv(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Returns null for "everything" (`*`, or unset when not required) and undefined
// when a required allowlist is missing.
function allowlist(name: string, required: boolean): string[] | null | undefined {
  const items = csv(name);
  if (items.includes('*')) return null;
  if (items.length) return items;
  return required ? undefined : null;
}

export function loadConfig(): Config {
  const apps = new Set<App>();
  for (const a of csv('MAC_ORGANISER_APPS')) {
    if (a === 'reminders' || a === 'calendar' || a === 'notes') apps.add(a);
    else console.error(`mac-organiser-mcp: ignoring unknown app "${a}"`);
  }

  const calendars = allowlist('CALENDAR_CALENDARS', true);
  if (apps.has('calendar') && calendars === undefined) {
    console.error('mac-organiser-mcp: calendar disabled; set CALENDAR_CALENDARS (or "*")');
    apps.delete('calendar');
  }
  const folders = allowlist('NOTES_FOLDERS', true);
  if (apps.has('notes') && folders === undefined) {
    console.error('mac-organiser-mcp: notes disabled; set NOTES_FOLDERS (or "*")');
    apps.delete('notes');
  }
  if (!apps.size) console.error('mac-organiser-mcp: no apps enabled; set MAC_ORGANISER_APPS');

  return {
    apps,
    reminders: {
      allowed: allowlist('REMINDERS_LISTS', false) ?? null,
      readOnly: flag('REMINDERS_READ_ONLY'),
      allowDelete: flag('REMINDERS_ALLOW_DELETE'),
      allowDetails: flag('REMINDERS_ALLOW_NOTES'),
      maxResults: int('REMINDERS_MAX_RESULTS', 50, 500),
    },
    calendar: {
      allowed: calendars === undefined ? [] : calendars,
      readOnly: flag('CALENDAR_READ_ONLY'),
      allowDelete: flag('CALENDAR_ALLOW_DELETE'),
      allowDetails: flag('CALENDAR_ALLOW_DETAILS'),
      maxResults: int('CALENDAR_MAX_RESULTS', 100, 1000),
    },
    notes: {
      allowed: folders === undefined ? [] : folders,
      readOnly: flag('NOTES_READ_ONLY'),
      allowDelete: false,
      allowDetails: true,
      maxResults: int('NOTES_MAX_RESULTS', 50, 500),
      maxChars: int('NOTES_MAX_CHARS', 20_000, 200_000),
    },
  };
}

import type { ActiveWindowInfo, Employer } from './types';

const DEFAULT_UNRELATED_KEYWORDS = [
  'facebook', 'twitter', 'instagram', 'tiktok', 'youtube', 'pinterest',
  'reddit', 'snapchat', 'steam', 'epic games', 'league of legends', 'fortnite', 'roblox',
  'discord', 'netflix', 'hulu', 'twitch',
];

const SELF_APP_NAMES = [
  'va worker time tracker',
  'va-worker-time-tracker',
  'va_worker_time_tracker',
  'va4hire',
  'va worker',
  'va trackme',
  'trackme',
];

export function isTrackerAppWindow(activeWindow: ActiveWindowInfo | null | undefined): boolean {
  const lcTitle = (activeWindow?.windowTitle || '').toLowerCase();
  const lcModule = (activeWindow?.moduleName || '').toLowerCase();
  const lcPath = (activeWindow?.moduleFilename || '').toLowerCase();
  for (const name of SELF_APP_NAMES) {
    if (lcTitle.includes(name) || lcModule.includes(name)) return true;
  }
  if (lcPath.includes('va trackme') || lcPath.includes('va-worker-time-tracker')) return true;
  return false;
}

export function buildDetectionText(activeWindow: ActiveWindowInfo | null | undefined): string {
  const title = (activeWindow?.windowTitle || '').trim();
  const module = (activeWindow?.moduleName || '').trim();
  return [title, module].filter(Boolean).join(' ');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseEmployerKeywords(
  employer: Employer | null | undefined,
  defaults: string[] = DEFAULT_UNRELATED_KEYWORDS,
): string[] {
  const val = employer?.unrelated_keywords;
  if (val == null || val === '') return defaults;
  if (Array.isArray(val)) {
    const parsed = val.map((item) => String(item).trim()).filter(Boolean);
    return parsed.length ? parsed : defaults;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return defaults;
    if (trimmed.startsWith('[')) {
      try {
        const json = JSON.parse(trimmed) as unknown;
        if (Array.isArray(json)) {
          const parsed = json.map((item) => String(item).trim()).filter(Boolean);
          return parsed.length ? parsed : defaults;
        }
      } catch {
        // fall through to comma-separated parsing
      }
    }
    const parsed = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    return parsed.length ? parsed : defaults;
  }
  return defaults;
}

export function keywordMatches(text: string, keyword: string): boolean {
  const normalized = keyword.toLowerCase().trim();
  if (!normalized) return false;
  const haystack = text.toLowerCase();
  if (normalized.includes(' ')) {
    return haystack.includes(normalized);
  }
  const escaped = escapeRegex(normalized);
  const wordPattern = new RegExp(`\\b${escaped}\\b`, 'i');
  if (wordPattern.test(haystack)) return true;
  const domainPattern = new RegExp(`(?:^|[/.@])${escaped}(?:[./\\s:?#&-]|$)`, 'i');
  return domainPattern.test(haystack);
}

export function detectUnrelatedKeywords(
  activeWindow: ActiveWindowInfo | null | undefined,
  keywords: string[],
  options?: { ignored?: string[]; snoozes?: Record<string, number> },
): string[] {
  if (isTrackerAppWindow(activeWindow)) return [];
  const text = buildDetectionText(activeWindow);
  if (!text) return [];

  const now = Date.now();
  const ignored = new Set(options?.ignored || []);
  const snoozes = options?.snoozes || {};
  const matches: string[] = [];

  for (const kw of keywords) {
    const normalized = String(kw).toLowerCase().trim();
    if (!normalized || ignored.has(normalized)) continue;
    const snoozeUntil = snoozes[normalized];
    if (snoozeUntil && snoozeUntil > now) continue;
    if (keywordMatches(text, normalized)) matches.push(normalized);
  }

  return [...new Set(matches)];
}

export function formatUnrelatedRemark(keywords: string[]): string {
  return `UNRELATED:${keywords.join(',')}`;
}

export function buildUnrelatedReportKey(keywords: string[], windowTitle: string): string {
  return `${[...keywords].sort().join(',')}|${windowTitle}`;
}

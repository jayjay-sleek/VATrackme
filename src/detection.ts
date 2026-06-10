import type { ActiveWindowInfo, Employer, TrackerData, TrackingSelection } from './types';

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

function pickNumericId(value: unknown): number | undefined {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

function pickExemptedValue(source: Record<string, unknown> | null | undefined): unknown {
  if (!source) return undefined;
  return source.worker_ids_exempted
    ?? source.WorkerIdsExempted
    ?? source.worker_ids_exempted_unrelated;
}

export function parseWorkerIdsExempted(value: unknown): number[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    const ids: number[] = [];
    for (const entry of value) {
      if (entry != null && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const nested = pickNumericId(record.id ?? record.worker_id ?? record.user_id);
        if (nested) ids.push(nested);
        continue;
      }
      const id = pickNumericId(entry);
      if (id) ids.push(id);
    }
    return [...new Set(ids)];
  }
  if (typeof value === 'object') {
    const ids: number[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === false || entry === 0 || entry === '0') continue;
      const fromKey = pickNumericId(key);
      if (fromKey) ids.push(fromKey);
      const fromValue = pickNumericId(entry);
      if (fromValue) ids.push(fromValue);
    }
    return [...new Set(ids)];
  }
  if (typeof value === 'number') {
    const id = pickNumericId(value);
    return id ? [id] : [];
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return parseWorkerIdsExempted(JSON.parse(trimmed) as unknown);
      } catch {
        // fall through to comma-separated parsing
      }
    }
    return [...new Set(
      trimmed
        .split(/[,\s;]+/)
        .map((item) => pickNumericId(item))
        .filter((id): id is number => id != null),
    )];
  }
  return [];
}

export function extractWorkerIdsExempted(
  data: TrackerData | null | undefined,
  employer?: Employer | null,
): number[] {
  const merged = new Set<number>();
  for (const value of [
    pickExemptedValue(employer as Record<string, unknown> | undefined),
    pickExemptedValue(data as Record<string, unknown> | undefined),
  ]) {
    for (const id of parseWorkerIdsExempted(value)) {
      merged.add(id);
    }
  }
  return [...merged];
}

export function collectTrackerWorkerIds(
  data: TrackerData | null | undefined,
  selection?: TrackingSelection | null,
): number[] {
  const raw = data as Record<string, unknown> | null | undefined;
  const employerRaw = selection?.employer as Record<string, unknown> | undefined;
  const candidates = [
    raw?.id,
    raw?.worker_id,
    raw?.Worker_id,
    raw?.user_id,
    raw?.User_id,
    selection?.project?.user_id,
    employerRaw?.worker_id,
    employerRaw?.Worker_id,
    employerRaw?.user_id,
    employerRaw?.User_id,
  ];
  const ids = new Set<number>();
  for (const candidate of candidates) {
    const id = pickNumericId(candidate);
    if (id) ids.add(id);
  }
  return [...ids];
}

export function isWorkerExemptFromUnrelatedDetection(
  workerIds: Array<number | undefined> | number | undefined,
  exemptedWorkerIds: number[],
): boolean {
  if (!exemptedWorkerIds.length) return false;
  const normalizedWorkerIds = new Set(
    (Array.isArray(workerIds) ? workerIds : [workerIds])
      .map((id) => pickNumericId(id))
      .filter((id): id is number => id != null)
      .map((id) => String(id)),
  );
  if (!normalizedWorkerIds.size) return false;
  return exemptedWorkerIds.some((id) => normalizedWorkerIds.has(String(id)));
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

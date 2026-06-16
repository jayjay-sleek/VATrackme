const path = require('node:path');

const UPDATE_BASE_URLS = {
  win32: 'https://www.va4hire.ph/download/app/',
  darwin: 'https://va4hire.ph/download/mac/',
};

const INSTALLER_PATTERNS = {
  win32: /VA\s*Trackme\s*Setup\s+(\d+\.\d+\.\d+[^"'<\s]*)\.exe/i,
  darwin: /VA\s*Trackme[\s-]+(\d+\.\d+\.\d+(?:-(?:arm64|x64|universal))?)\.dmg/i,
};

function compareSemver(left, right) {
  const leftParts = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

function normalizeVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function resolveUrl(baseUrl, target) {
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) return target;
  return new URL(target, baseUrl).href;
}

async function fetchText(url) {
  const fetchImpl = global.fetch || require('node-fetch');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,text/html,*/*',
      },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.text();
  } catch (_error) {
    clearTimeout(timeout);
    return null;
  }
}

function parseVersionManifest(text, baseUrl) {
  try {
    const parsed = JSON.parse(text);
    const version = normalizeVersion(parsed.version ?? parsed.latestVersion ?? parsed.appVersion);
    if (!version) return null;

    const downloadUrl = resolveUrl(
      baseUrl,
      parsed.downloadUrl ?? parsed.url ?? parsed.file ?? parsed.filename,
    );
    const releaseNotes = String(parsed.releaseNotes ?? parsed.notes ?? parsed.message ?? '').trim();

    return {
      version,
      downloadUrl,
      releaseNotes: releaseNotes || undefined,
    };
  } catch (_error) {
    return null;
  }
}

function parseInstallersFromHtml(html, platform, baseUrl) {
  const pattern = INSTALLER_PATTERNS[platform];
  if (!pattern || !html) return [];

  const matches = [];
  const hrefPattern = /href=["']([^"']+)["']/gi;
  let hrefMatch = hrefPattern.exec(html);

  while (hrefMatch) {
    const href = hrefMatch[1];
    const candidate = decodeURIComponent(href.split('/').pop() || href);
    const versionMatch = candidate.match(pattern);
    if (versionMatch) {
      matches.push({
        version: normalizeVersion(versionMatch[1]),
        downloadUrl: resolveUrl(baseUrl, href),
        filename: candidate,
      });
    }
    hrefMatch = hrefPattern.exec(html);
  }

  const inlinePattern = platform === 'win32'
    ? /VA\s*Trackme\s*Setup\s+\d+\.\d+\.\d+[^"'<\s]*\.exe/gi
    : /VA\s*Trackme[\s-]+\d+\.\d+\.\d+(?:-(?:arm64|x64|universal))?\.dmg/gi;
  const inlineMatches = html.match(inlinePattern) || [];

  for (const filename of inlineMatches) {
    const versionMatch = filename.match(pattern);
    if (!versionMatch) continue;
    matches.push({
      version: normalizeVersion(versionMatch[1]),
      downloadUrl: resolveUrl(baseUrl, filename),
      filename,
    });
  }

  const deduped = new Map();
  for (const entry of matches) {
    if (!entry.version || !entry.downloadUrl) continue;
    const existing = deduped.get(entry.version);
    if (!existing || (process.arch === 'arm64' && /arm64/i.test(entry.filename))) {
      deduped.set(entry.version, entry);
    }
  }

  return [...deduped.values()].sort((left, right) => compareSemver(right.version, left.version));
}

function pickLatestRelease(entries, platform) {
  if (!entries.length) return null;

  if (platform === 'darwin' && process.arch === 'arm64') {
    const armEntry = entries.find((entry) => /arm64/i.test(entry.filename || entry.downloadUrl || ''));
    if (armEntry) return armEntry;
  }

  if (platform === 'darwin' && process.arch === 'x64') {
    const x64Entry = entries.find((entry) => /x64/i.test(entry.filename || entry.downloadUrl || ''));
    if (x64Entry) return x64Entry;
  }

  return entries[0];
}

function buildFallbackDownloadUrl(baseUrl, platform, version) {
  if (platform === 'win32') {
    return resolveUrl(baseUrl, `VA Trackme Setup ${version}.exe`);
  }
  if (platform === 'darwin') {
    if (process.arch === 'arm64') {
      return resolveUrl(baseUrl, `VA Trackme-${version}-arm64.dmg`);
    }
    return resolveUrl(baseUrl, `VA Trackme-${version}.dmg`);
  }
  return null;
}

async function checkForUpdate(currentVersion) {
  const platform = process.platform;
  const baseUrl = UPDATE_BASE_URLS[platform];

  if (!baseUrl) {
    return {
      ok: false,
      currentVersion,
      error: 'Updates are not supported on this platform.',
    };
  }

  let latest = null;
  const manifestText = await fetchText(new URL('version.json', baseUrl).href);
  if (manifestText) {
    latest = parseVersionManifest(manifestText, baseUrl);
  }

  if (!latest) {
    const indexText = await fetchText(baseUrl);
    const entries = parseInstallersFromHtml(indexText, platform, baseUrl);
    latest = pickLatestRelease(entries, platform);
  }

  if (!latest?.version) {
    return {
      ok: false,
      currentVersion,
      error: 'Unable to check for updates right now.',
    };
  }

  const downloadUrl = latest.downloadUrl || buildFallbackDownloadUrl(baseUrl, platform, latest.version);
  const updateAvailable = compareSemver(latest.version, currentVersion) > 0;

  return {
    ok: true,
    currentVersion,
    latestVersion: latest.version,
    downloadUrl,
    releaseNotes: latest.releaseNotes,
    updateAvailable,
  };
}

module.exports = {
  UPDATE_BASE_URLS,
  checkForUpdate,
  compareSemver,
};

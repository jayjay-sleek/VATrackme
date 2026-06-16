export type UpdateCheckResult = {
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  updateAvailable?: boolean;
  error?: string;
};

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  if (!window.desktopApi.checkForUpdate) {
    return {
      ok: false,
      currentVersion: '0.0.0',
      error: 'Update checks are unavailable in this build.',
    };
  }
  return window.desktopApi.checkForUpdate();
}

export async function downloadAppUpdate(downloadUrl: string): Promise<{ ok: boolean; error?: string }> {
  if (!window.desktopApi.downloadUpdate) {
    return { ok: false, error: 'Update downloads are unavailable in this build.' };
  }
  return window.desktopApi.downloadUpdate(downloadUrl);
}

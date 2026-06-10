const path = require('node:path');
const fs = require('node:fs');
const { nativeImage } = require('electron');

function getResourcePath(...segments) {
  return path.join(__dirname, '..', ...segments);
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getWindowIconPath() {
  if (process.platform === 'win32') {
    return firstExistingPath([
      getResourcePath('build', 'icon.ico'),
      getResourcePath('assets', 'icon-256.png'),
      getResourcePath('assets', 'icon-clock-circle.png'),
    ]);
  }

  if (process.platform === 'darwin') {
    return firstExistingPath([
      getResourcePath('build', 'icon.icns'),
      getResourcePath('build', 'icon.png'),
      getResourcePath('build', 'icon-512.png'),
      getResourcePath('assets', 'icon-256.png'),
      getResourcePath('assets', 'icon-clock-circle.png'),
    ]);
  }

  return firstExistingPath([
    getResourcePath('build', 'icon-256.png'),
    getResourcePath('build', 'icon.png'),
    getResourcePath('assets', 'icon-256.png'),
    getResourcePath('assets', 'icon-clock-circle.png'),
  ]);
}

function getTrayIconImage() {
  const trayPath = firstExistingPath([
    getResourcePath('build', 'icon-32.png'),
    getResourcePath('assets', 'icon-32.png'),
    getResourcePath('build', 'icon-48.png'),
    getResourcePath('assets', 'icon-clock-circle.png'),
  ]);

  if (!trayPath) {
    return nativeImage.createEmpty();
  }

  const image = nativeImage.createFromPath(trayPath);
  if (process.platform === 'darwin') {
    return image.resize({ width: 22, height: 22 });
  }
  if (process.platform === 'win32') {
    return image.resize({ width: 16, height: 16 });
  }
  return image.resize({ width: 24, height: 24 });
}

module.exports = {
  getWindowIconPath,
  getTrayIconImage,
};

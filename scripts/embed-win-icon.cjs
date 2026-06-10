const path = require('node:path');

const { rcedit } = require('rcedit');

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function embedWinIcon(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const exePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');

  await rcedit(exePath, { icon: iconPath });
  console.log(`Embedded icon into ${exePath}`);
};

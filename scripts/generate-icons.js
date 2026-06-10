const fs = require('node:fs');
const path = require('node:path');

const sharp = require('sharp');

const rootDir = path.join(__dirname, '..');
const sourceIcon = path.join(rootDir, 'assets', 'icon-clock-circle.png');
const buildDir = path.join(rootDir, 'build');

const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

async function generateIcons() {
  if (!fs.existsSync(sourceIcon)) {
    throw new Error(`Source icon not found: ${sourceIcon}`);
  }

  fs.mkdirSync(buildDir, { recursive: true });

  const source = sharp(sourceIcon).resize(1024, 1024, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  for (const size of pngSizes) {
    const output = path.join(buildDir, `icon-${size}.png`);
    await source
      .clone()
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9 })
      .toFile(output);
    console.log(`Wrote ${path.relative(rootDir, output)}`);
  }

  const masterPng = path.join(buildDir, 'icon.png');
  await sharp(sourceIcon)
    .resize(1024, 1024, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(masterPng);
  console.log(`Wrote ${path.relative(rootDir, masterPng)}`);

  const pngToIco = (await import('png-to-ico')).default;
  const icoInputs = icoSizes.map((size) => path.join(buildDir, `icon-${size}.png`));
  const icoBuffer = await pngToIco(icoInputs);
  const icoPath = path.join(buildDir, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`Wrote ${path.relative(rootDir, icoPath)}`);

  const assets32 = path.join(rootDir, 'assets', 'icon-32.png');
  const assets256 = path.join(rootDir, 'assets', 'icon-256.png');
  fs.copyFileSync(path.join(buildDir, 'icon-32.png'), assets32);
  fs.copyFileSync(path.join(buildDir, 'icon-256.png'), assets256);
  console.log(`Wrote ${path.relative(rootDir, assets32)}`);
  console.log(`Wrote ${path.relative(rootDir, assets256)}`);

  const publicAssetsDir = path.join(rootDir, 'public', 'assets');
  fs.mkdirSync(publicAssetsDir, { recursive: true });
  fs.copyFileSync(assets32, path.join(publicAssetsDir, 'icon-32.png'));
  fs.copyFileSync(assets256, path.join(publicAssetsDir, 'icon-256.png'));
  console.log(`Wrote public/assets icon files for dev favicon`);
}

generateIcons().catch((error) => {
  console.error(error);
  process.exit(1);
});

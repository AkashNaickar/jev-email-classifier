// Build script: bundles the MV3 extension with esbuild into dist/.
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateIcons } from './gen-icons.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, '..', 'dist');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  logLevel: 'info',
  legalComments: 'none',
};

/** @type {import('esbuild').BuildOptions} */
const serviceWorker = {
  ...common,
  entryPoints: [join(root, '..', 'src/background/service-worker.ts')],
  outfile: join(outdir, 'service-worker.js'),
  format: 'esm',
};

/** @type {import('esbuild').BuildOptions} */
const contentScript = {
  ...common,
  entryPoints: [join(root, '..', 'src/content/content.ts')],
  outfile: join(outdir, 'content.js'),
  format: 'iife',
};

/** @type {import('esbuild').BuildOptions} */
const popup = {
  ...common,
  entryPoints: [join(root, '..', 'src/popup/popup.ts')],
  outfile: join(outdir, 'popup.js'),
  format: 'esm',
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  ...common,
  entryPoints: [join(root, '..', 'src/options/options.ts')],
  outfile: join(outdir, 'options.js'),
  format: 'esm',
};

const configs = [serviceWorker, contentScript, popup, options];

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await cp(join(root, '..', 'public/manifest.json'), join(outdir, 'manifest.json'));
  await cp(join(root, '..', 'src/popup/popup.html'), join(outdir, 'popup.html'));
  await cp(join(root, '..', 'src/options/options.html'), join(outdir, 'options.html'));
  await cp(join(root, '..', 'src/content/styles.css'), join(outdir, 'styles.css'));
  const iconsSrc = join(root, '..', 'public/icons');
  const iconsDst = join(outdir, 'icons');
  await mkdir(iconsDst, { recursive: true });
  await cp(iconsSrc, iconsDst, { recursive: true });
}

async function main() {
  if (!existsSync(join(root, '..', 'public/icons/icon128.png'))) {
    await generateIcons();
  }
  if (!watch) {
    await rm(outdir, { recursive: true, force: true });
  }
  await copyStatic();

  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('watching for changes...');
    return;
  }
  await Promise.all(configs.map((c) => build(c)));
  // Sanity: fail loudly if a referenced page file is missing.
  for (const f of ['manifest.json', 'popup.html', 'options.html', 'content.js', 'service-worker.js']) {
    await readFile(join(outdir, f));
  }
  console.log(`built dist/ -> ${outdir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

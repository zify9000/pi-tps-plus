// 用 pi 自带的 esbuild 把扩展编成一份可被 node 直接 import 的 ESM，
// 好让 dev/harness.mjs 和 dev/render-real.mjs 能在 pi 之外跑它。
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findPiRoot, piNodeModules } from './pi-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const CHECK_DIR = join(ROOT, '.check');
export const CHECK_BUNDLE = join(CHECK_DIR, 'extension.mjs');

export async function build() {
  const piRoot = findPiRoot();

  const esbuildEntry = join(piNodeModules(piRoot), 'esbuild/lib/main.js');
  if (!existsSync(esbuildEntry)) throw new Error(`pi 的 esbuild 不在 ${esbuildEntry}`);
  const esbuild = await import(pathToFileURL(esbuildEntry).href);

  // The bundle keeps a runtime `import '@earendil-works/pi-tui'` (pi injects that
  // alias at load time). Node needs the same alias, so expose pi's own copy.
  mkdirSync(CHECK_DIR, { recursive: true });
  const linkDir = join(CHECK_DIR, 'node_modules/@earendil-works');
  mkdirSync(linkDir, { recursive: true });
  const link = join(linkDir, 'pi-tui');
  const target = join(piNodeModules(piRoot), '@earendil-works/pi-tui');
  if (!existsSync(target)) throw new Error(`pi-tui 不在 ${target}`);
  if (safeReadlink(link) !== target) {
    rmSync(link, { force: true, recursive: true });
    symlinkSync(target, link, 'dir');
  }

  await esbuild.build({
    entryPoints: [join(ROOT, 'extensions/pi-tps-plus.ts')],
    outfile: CHECK_BUNDLE,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
  });

  return { bundle: CHECK_BUNDLE, piRoot };
}

function safeReadlink(p) {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

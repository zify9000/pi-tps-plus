// 定位本机的 pi 安装目录（= @earendil-works/pi-coding-agent 包目录）。
// 开发脚本要在那里找 esbuild / pi-tui / theme，因为它们由 pi 自带、不在本仓库里。
import { execSync } from 'node:child_process';
import { existsSync, globSync, realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PKG = '@earendil-works/pi-coding-agent';

function isPiRoot(dir) {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).name === PKG;
  } catch {
    return false;
  }
}

export function findPiRoot() {
  if (process.env.PI_ROOT) {
    const dir = resolve(process.env.PI_ROOT);
    if (isPiRoot(dir)) return dir;
    throw new Error(`PI_ROOT=${dir} 不是 ${PKG} 的包目录`);
  }

  // 1) follow the `pi` launcher on PATH
  try {
    const bin = execSync('command -v pi', { shell: '/bin/bash', encoding: 'utf8' }).trim();
    let dir = dirname(realpathSync(bin));
    for (let i = 0; i < 8 && dir !== dirname(dir); i++, dir = dirname(dir)) {
      if (isPiRoot(dir)) return dir;
      const nested = join(dir, 'node_modules', PKG);
      if (isPiRoot(nested)) return nested;
    }
  } catch {
    /* no pi on PATH */
  }

  // 2) common global install roots (nvm, npm -g, homebrew)
  const candidates = [
    ...globSync(join(homedir(), `.nvm/versions/node/*/lib/node_modules/${PKG}`)),
    ...globSync(join(homedir(), '.local/share/mise/installs/node/*/lib/node_modules/' + PKG)),
    `/usr/local/lib/node_modules/${PKG}`,
    `/opt/homebrew/lib/node_modules/${PKG}`,
    join(homedir(), `node_modules/${PKG}`),
  ];
  for (const c of candidates) if (isPiRoot(c)) return c;

  throw new Error(
    `找不到 ${PKG} 的包目录。装好 pi 后重试，或显式指定：PI_ROOT=/path/to/${PKG} npm run check`
  );
}

/** Host-provided packages pi injects into extensions resolve from here. */
export function piNodeModules(piRoot = findPiRoot()) {
  return join(piRoot, 'node_modules');
}

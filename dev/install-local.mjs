// 把仓库里的扩展装到本机 pi 的 autoload 目录：仓库副本 = 唯一真相。
// 用法：
//   node dev/install-local.mjs             拷贝并设为只读（本机副本一改就会报错，逼你改仓库）
//   node dev/install-local.mjs --dev       拷贝为可写（临时在实机上调，记得改回仓库）
//   node dev/install-local.mjs --uninstall 删除本机安装
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'extensions/pi-tps-plus.ts');
const TARGET_DIR = join(homedir(), '.pi/agent/extensions/pi-tps-plus');
const TARGET = join(TARGET_DIR, 'index.ts');
const MARKER = 'pi-tps-plus';
const args = process.argv.slice(2);

function looksLikeOurs(file) {
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8').slice(0, 400).includes(MARKER);
}

if (args.includes('--uninstall')) {
  if (existsSync(TARGET_DIR) && !looksLikeOurs(TARGET)) {
    console.error(`不动 ${TARGET_DIR}：里面的 index.ts 不是本仓库装的，自己确认后再删。`);
    process.exit(1);
  }
  rmSync(TARGET_DIR, { recursive: true, force: true });
  console.log(`已删除 ${TARGET_DIR}`);
  process.exit(0);
}

if (!existsSync(SRC)) {
  console.error(`找不到源文件 ${SRC}（在仓库根目录跑这个脚本）`);
  process.exit(1);
}

if (existsSync(TARGET)) chmodSync(TARGET, 0o644); // 已是只读副本时先解锁再覆盖
mkdirSync(TARGET_DIR, { recursive: true });
copyFileSync(SRC, TARGET);
const writable = args.includes('--dev');
chmodSync(TARGET, writable ? 0o644 : 0o444);

// Two TPS extensions at once = two banners per turn (we hit that during the fork).
const settings = join(homedir(), '.pi/agent/settings.json');
if (existsSync(settings)) {
  const text = readFileSync(settings, 'utf8');
  if (/monotykamary\/pi-tps|npm:.*pi-tps(?!-plus)/.test(text)) {
    console.warn('警告：settings.json 里还装着另一个 pi-tps 包，会出现两条 banner，二选一。');
  }
}

console.log(`已安装 ${TARGET}  (${writable ? '可写 --dev' : '只读'})`);
console.log('在 pi 里执行 /reload 生效（或重启 pi）。');

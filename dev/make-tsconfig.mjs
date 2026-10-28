// 生成 .check/tsconfig.json：把 pi 注入给扩展的主机包映射到本机 pi 安装里的 .d.ts。
// 仓库不 vendor 这些类型，也不该装它们进 dependencies（docs/packages.md：会造出重复类/注册表）。
// 用法：npm run typecheck   （需要先 npm i）
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPiRoot, piNodeModules } from './pi-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

if (!existsSync(join(ROOT, 'node_modules/typescript'))) {
  console.error('还没有本地 devDependencies：先跑 npm i（typescript / @types/node 只用于 typecheck）');
  process.exit(1);
}

const piRoot = findPiRoot();
const host = piNodeModules(piRoot);
const paths = {
  '@earendil-works/pi-coding-agent': [join(piRoot, 'dist/index.d.ts')],
  '@earendil-works/pi-tui': [join(host, '@earendil-works/pi-tui/dist/index.d.ts')],
  '@earendil-works/pi-ai': [join(host, '@earendil-works/pi-ai/dist/index.d.ts')],
};

for (const [, targets] of Object.entries(paths)) {
  for (const t of targets) {
    if (!existsSync(t)) {
      console.error(`缺少类型文件 ${t}\npi 的版本可能变了，检查这个版本的目录结构。`);
      process.exit(1);
    }
  }
}

mkdirSync(join(ROOT, '.check'), { recursive: true });
writeFileSync(
  join(ROOT, '.check/tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        types: ['node'],
        typeRoots: [join(ROOT, 'node_modules/@types')],
        baseUrl: ROOT,
        paths,
      },
      include: [join(ROOT, 'extensions/**/*.ts')],
    },
    null,
    2
  )}\n`
);
console.log(`wrote .check/tsconfig.json (pi: ${piRoot})`);

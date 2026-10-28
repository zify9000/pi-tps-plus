// 高亮候选样式对照（在你的终端里跑出真实颜色，选一个填回 LOOP_HEAD_STYLE）
// 用法：node dev/demo-highlight.mjs [themeName]
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { findPiRoot } from './pi-root.mjs';

// pi 自己提供的主题引擎（不在本仓库里，随 pi 安装）
const piTheme = await import(pathToFileURL(join(findPiRoot(), 'dist/modes/interactive/theme/theme.js')).href);
const { initTheme, theme, getAvailableThemes } = piTheme;

initTheme(process.argv[2]);

const row = 'LOOP #3 -> 21 turns · 4m 12s / 63 tools · 3m 10s / in 200K · out 50K · 1m 3s / TPS 91.3';
const row2 = '        -> 42 bash · 10s / 8 edit · 9.4s / 12 read · 1.9s';
const cut = row.indexOf(' / '); // 高亮跨度：LOOP 标题 → turns → 墙钟（第一个 ` / ` 之前）
const head = row.slice(0, cut);
const tail = row.slice(cut);

const styles = {
  'plain': (t) => t,
  'accent': (t) => theme.fg('accent', t),
  'accentBold': (t) => theme.fg('accent', theme.bold(t)),
  'bold': (t) => theme.bold(t),
  'textContrast': (t) => theme.fg('text', t),
  'success': (t) => theme.fg('success', t),
  'inverse': (t) => theme.inverse(t),
  'underline': (t) => theme.underline(t),
  'bgSelected': (t) => theme.bg('selectedBg', t),
  'bgCustomMsg': (t) => theme.bg('customMessageBg', t),
};

console.log(`theme: ${theme.name ?? '(unknown)'}  accent=${JSON.stringify(theme.colors.accent)}  dim=${JSON.stringify(theme.colors.dim)}`);
console.log(`可用主题: ${getAvailableThemes().join(', ')}\n`);

for (const [name, fn] of Object.entries(styles)) {
  // transcript 通道：我们自己上色，续行保持 dim
  const transcript = `${fn(head)}${theme.fg('dim', tail)}`;
  // status 通道：pi 的 showStatus 会把整条消息包成 dim —— 我们的颜色被 dim 覆盖一层
  const statusNaive = theme.fg('dim', `${fn(head)}${tail}`);
  // status 通道 + SGR 22（pi 自己用来结束 dim 的那个码）先解除 faint
  const statusUndim = theme.fg('dim', `\x1b[22m${fn(head)}${tail}`);

  console.log(`── ${name}`);
  console.log(`  transcript: ${transcript}`);
  console.log(`  ${theme.fg('dim', row2)}`);
  console.log(`  status    : ${statusNaive}`);
  console.log(`  status+22 : ${statusUndim}`);
  console.log();
}

// 纯 ASCII 标记变体：不依赖 ANSI，notify 被包成 dim 时也照样可见
console.log('── 纯标记（无 ANSI，两条通道都稳）');
for (const mark of ['▸ ', '◆ ', '* ', '» ']) {
  console.log(`  ${mark}${theme.fg('dim', row)}`);
}

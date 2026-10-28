// 用真实 session 条目渲染扩展的两条显示通道（改样式不用重跑 pi）
// 用法：node dev/render-real.mjs [loopIndex] [themeName] [--expanded] [--plain] [--dir=<session dir>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from './build.mjs';
import { findPiRoot } from './pi-root.mjs';

const args = process.argv.slice(2);
const expanded = args.includes('--expanded');
const plainMode = args.includes('--plain');
const dirArg = args.find((a) => a.startsWith('--dir='));
const positional = args.filter((a) => !a.startsWith('--'));
const want = positional[0] && /^\d+$/.test(positional[0]) ? Number(positional[0]) : null;
const themeName = positional.find((a) => !/^\d+$/.test(a));

await build();
const ext = await import(pathToFileURL(join(process.cwd(), '.check/extension.mjs')).href);
const { initTheme, theme } = await import(
  pathToFileURL(join(findPiRoot(), 'dist/modes/interactive/theme/theme.js')).href
);
initTheme(themeName);

// Register the entry renderer by loading the extension against a stub API.
const renderers = new Map();
const stub = {
  on: () => {},
  registerCommand: () => {},
  registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
  appendEntry: () => {},
  events: { on: () => {}, emit: () => {} },
  setActiveTool: () => {},
  setWorkingMessage: () => {},
};
ext.default(stub);
const renderEntry = renderers.get('loopstats');
const plainTheme = { fg: (_c, t) => t, bold: (t) => t, underline: (t) => t, inverse: (t) => t, bg: (_c, t) => t };
const activeTheme = plainMode ? plainTheme : theme;

// pi names the session directory after the cwd: '/' → '-', wrapped in '--'.
const sessionDir =
  dirArg?.slice('--dir='.length) ?? join(homedir(), '.pi/agent/sessions', `--${process.cwd().replace(/\//g, '-')}--`);
if (!existsSync(sessionDir)) {
  console.error(`没有 session 目录：${sessionDir}\n在这个 cwd 下跑过一次带工具的 loop，或用 --dir= 指定。`);
  process.exit(1);
}

const files = readdirSync(sessionDir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => [statSync(join(sessionDir, f)).mtimeMs, f])
  .sort((a, b) => b[0] - a[0]);

const width = process.stdout.columns ?? 100;
let shown = 0;
for (const [, f] of files) {
  for (const line of readFileSync(join(sessionDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'custom' || entry.customType !== 'loopstats' || !entry.data?.toolStats) continue;
    if (want !== null && entry.data.loopIndex !== want) continue;

    const loop = entry.data;
    const summary = ext.composeLoopString(loop);
    const budget = Math.max(20, width - ext.arrowIndent(summary).length - '-> '.length);
    const breakdown = ext.composeToolBreakdown(loop, undefined, budget);
    const statusRows = ext.renderLoopStats(loop, plainMode ? undefined : theme).split('\n');

    console.log(`── ${f}  (${width} 列，theme ${plainMode ? 'plain' : theme.name ?? 'system'})`);
    console.log('status 通道（notify：pi 会把整包包成 dim，头部用 SGR 22 解除）:');
    for (const r of statusRows) console.log(`  |${r}|`);

    if (renderEntry) {
      const component = renderEntry(
        { type: 'custom', customType: 'loopstats', data: loop },
        { expanded },
        activeTheme
      );
      console.log(`transcript 通道（entry renderer${expanded ? '，expanded' : ''}）:`);
      for (const r of component ? component.render(width) : []) console.log(`  |${r}|`);
      console.log(`  展开行字段: ${ext.formatLoopDetail(loop)}`);
    } else {
      console.log('transcript 通道: 未注册 loopstats renderer');
    }
    console.log(`  行宽: 首行 ${summary.length} / 明细 ${breakdown ? ext.composeToolBreakdownLine(summary, breakdown).length : 0}`);
    console.log();

    if (++shown >= (want !== null ? 1 : 3)) process.exit(0);
  }
}
if (shown === 0) console.log('这些 session 里没有带 toolStats 的 loopstats 条目（先跑一次带工具的 loop）');

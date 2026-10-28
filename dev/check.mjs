// 一条命令跑完整回归：编译 + 事件序列 + 数学 + 显示不变量 + 组件渲染
// 用法：npm run check
import { build } from './build.mjs';

const { bundle, piRoot } = await build();
console.log(`pi    : ${piRoot}`);
console.log(`bundle: ${bundle}\n`);
await import('./harness.mjs');

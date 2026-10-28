import mod from '../.check/extension.mjs';

const handlers = new Map();
const entries = [];
const notifications = [];
const commands = [];
const events = new Map();
const entryRenderers = new Map();

const pi = {
  on: (name, h) => { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(h); },
  registerCommand: (name, def) => commands.push({ name, ...def }),
  registerEntryRenderer: (type, renderer) => entryRenderers.set(type, renderer),
  appendEntry: (type, data) => entries.push({ type: 'custom', customType: type, data }),
  events: { on: (n, h) => events.set(n, [...(events.get(n) ?? []), h]), emit: (n, d) => (events.get(n) ?? []).forEach((h) => h(d)) },
};

const ctx = {
  hasUI: true,
  mode: 'tui',
  ui: { notify: (m) => notifications.push(m) },
  sessionManager: { getEntries: () => [...entries], getBranch: () => [...entries] },
};

const assistant = (output) => ({
  role: 'assistant', content: [{ type: 'text', text: 'x' }],
  usage: { input: 1000, output, cacheRead: 5000, cacheWrite: 0, totalTokens: 1000 + output + 5000,
           cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } },
  provider: 'local', model: 'test-model', stopReason: 'toolUse',
});
const update = (m) => ({ type: 'message_update', message: m, assistantMessageEvent: { type: 'textDelta' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamTurn(turnIndex, msg, updates, gapMs) {
  await dispatch('turn_start', { type: 'turn_start', turnIndex, timestamp: Date.now() });
  await dispatch('message_start', { type: 'message_start', message: msg });
  for (let i = 0; i < updates; i++) { await dispatch('message_update', update(msg)); await sleep(gapMs); }
  await dispatch('message_end', { type: 'message_end', message: msg });
}

async function dispatch(name, event) {
  for (const h of handlers.get(name) ?? []) await h(event, ctx);
}

mod(pi);
await dispatch('session_start', { type: 'session_start' });

// ── loop 1: one turn with three overlapping tool calls ──────────────────
await dispatch('agent_start', { type: 'agent_start' });
await streamTurn(0, assistant(120), 12, 30);

for (const id of ['a', 'b', 'c']) {
  await dispatch('tool_execution_start', { type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: {} });
}
await sleep(200);
await dispatch('tool_execution_update', { type: 'tool_execution_update', toolCallId: 'a', toolName: 'bash', args: {}, partialResult: {} });
await dispatch('tool_execution_end', { type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', result: {}, isError: false });
await sleep(150);
await dispatch('tool_execution_end', { type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', result: {}, isError: true });
await sleep(150);
await dispatch('tool_execution_end', { type: 'tool_execution_end', toolCallId: 'c', toolName: 'read', result: {}, isError: false });
await dispatch('turn_end', { type: 'turn_end', turnIndex: 0, message: assistant(120), toolResults: [], outcome: 'completed' });

// ── loop 1 second turn: no tools ────────────────────────────────────────
await streamTurn(1, assistant(60), 8, 25);
await dispatch('turn_end', { type: 'turn_end', turnIndex: 1, message: assistant(60), toolResults: [], outcome: 'completed' });

await dispatch('agent_end', { type: 'agent_end', messages: [], willRetry: false });
await dispatch('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' });
await dispatch('agent_settled', { type: 'agent_settled' });

// ── loop 2: aborted, one open tool call never closed ────────────────────
await dispatch('agent_start', { type: 'agent_start' });
await streamTurn(0, assistant(40), 6, 20);
await dispatch('tool_execution_start', { type: 'tool_execution_start', toolCallId: 'd', toolName: 'bash', args: {} });
await dispatch('tool_execution_start', { type: 'tool_execution_start', toolCallId: 'd/1', toolName: 'bash', args: {}, parentToolCallId: 'd' });
await sleep(120);
await dispatch('tool_execution_end', { type: 'tool_execution_end', toolCallId: 'd/1', toolName: 'bash', result: {}, isError: false });
await dispatch('turn_end', { type: 'turn_end', turnIndex: 0, message: assistant(40), toolResults: [], outcome: 'aborted' });
await dispatch('agent_end', { type: 'agent_end', messages: [], willRetry: false });
await dispatch('agent_before_settle', { type: 'agent_before_settle', outcome: 'aborted' });
await dispatch('agent_settled', { type: 'agent_settled' });

console.log('notifications:');
for (const n of notifications) console.log('  ' + n);
console.log('\ncustom types:', entries.map((e) => e.customType).join(', '));
const loops = entries.filter((e) => e.customType === 'loopstats').map((e) => e.data);
console.log('\nloopstats entries:');
for (const l of loops) console.log('  ' + JSON.stringify(l));
console.log('\nloopstats keys:', Object.keys(loops[0] ?? {}).join(','));
console.log('commands:', commands.map((c) => c.name).join(', '));

// ── /loopstats command ──────────────────────────────────────────────────
const persistedFromFile = entries.map((e) => ({ ...e }));
const cmd = commands.find((c) => c.name === 'loopstats');
notifications.length = 0;
await cmd.handler('', ctx);
console.log('\n/loopstats ->', notifications[0]);
notifications.length = 0;
await cmd.handler('--all', ctx);
console.log('/loopstats --all ->\n' + notifications[0].split('\n').map((l) => '  ' + l).join('\n'));


// ── second runtime (resume simulation) ─────────────────────────────────
const handlers2 = new Map();
const entries2 = [...persistedFromFile];
const pi2 = {
  on: (name, h) => { (handlers2.get(name) ?? handlers2.set(name, []).get(name)).push(h); },
  registerCommand: () => {},
  registerEntryRenderer: () => {},
  appendEntry: (type, data) => entries2.push({ type: 'custom', customType: type, data }),
  events: { on: () => {}, emit: () => {} },
};
const ctx2 = { hasUI: true, mode: 'tui', ui: { notify: (m) => notifications.push(m) },
  sessionManager: { getEntries: () => [...entries2], getBranch: () => [...entries2] } };
async function dispatch2(name, event) { for (const h of handlers2.get(name) ?? []) await h(event, ctx2); }
async function streamTurn2(turnIndex, msg, updates, gapMs) {
  await dispatch2('turn_start', { type: 'turn_start', turnIndex, timestamp: Date.now() });
  await dispatch2('message_start', { type: 'message_start', message: msg });
  for (let i = 0; i < updates; i++) { await dispatch2('message_update', update(msg)); await sleep(gapMs); }
  await dispatch2('message_end', { type: 'message_end', message: msg });
}

// ── resume: fresh extension instance must continue loop numbering ───────
notifications.length = 0;
handlers.clear();
entries.length = 0;
entries.push(...persistedFromFile);
mod(pi2);
await dispatch2('session_start', { type: 'session_start' });
await dispatch2('agent_start', { type: 'agent_start' });
await streamTurn2(0, assistant(30), 6, 20);
await dispatch2('turn_end', { type: 'turn_end', turnIndex: 0, message: assistant(30), toolResults: [] });
await dispatch2('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' });
await dispatch2('agent_settled', { type: 'agent_settled' });
console.log('\nafter resume:', notifications.filter((n) => n.startsWith('LOOP'))[0]);

// ── display invariants (pure functions: arrow alignment + width folding) ─
import {
  composeLoopString,
  composeLoopRows,
  composeLoopFlags,
  composeToolBreakdown,
  composeToolBreakdownLine,
  arrowIndent,
  renderLoopStats,
  styleLoopSummary,
  loopHeadEnd,
} from '../.check/extension.mjs';

const S = (s) => s * 1000;
const wideLoop = {
  ...loops[0],
  loopIndex: 12,
  toolStats: {
    bash:   { count: 41, busyMs: S(151), maxMs: S(41.2), errors: 1 },
    edit:   { count: 8,  busyMs: S(9.4), maxMs: S(3.1),  errors: 0 },
    read:   { count: 12, busyMs: S(1.9), maxMs: S(0.6),  errors: 0 },
    grep:   { count: 2,  busyMs: S(1.8), maxMs: S(1.5),  errors: 0 },
    find:   { count: 2,  busyMs: S(0.4), maxMs: S(0.2),  errors: 0 },
    recall: { count: 1,  busyMs: S(0.3), maxMs: S(0.3),  errors: 0 },
    write:  { count: 1,  busyMs: S(0.2), maxMs: S(0.2),  errors: 0 },
    ls:     { count: 1,  busyMs: S(0.1), maxMs: S(0.1),  errors: 0 },
  },
};

console.log('\ndisplay invariants:');
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); };

for (const width of [80, 100, 120, 140, 200]) {
  const row1 = composeLoopString(wideLoop);
  const budget = Math.max(20, width - arrowIndent(row1).length - '-> '.length);
  const row2 = composeToolBreakdownLine(row1, composeToolBreakdown(wideLoop, 6, budget));
  check(row1.indexOf('->') === row2.indexOf('->'), `arrows share column at ${width} cols`);
  check(row2.length <= Math.max(width, row1.length), `breakdown fits ${width} cols (${row2.length})`);
  check(/\+N?|^\S+ \S+ ·/.test(row2) && row2.includes('bash'), `slowest class always shown at ${width} cols`);
}

const abortLoop = { ...wideLoop, loopIndex: 4, turns: 1, wallMs: S(40), toolCalls: 7, toolMs: S(31), outcome: 'aborted', abortedAtTurn: 7, toolStats: { bash: { count: 5, busyMs: S(30), maxMs: S(20), errors: 0 }, edit: { count: 2, busyMs: S(2), maxMs: S(1), errors: 0 } } };
const abortTitle = composeLoopString(abortLoop);
const abortRows = composeLoopRows(abortLoop);
const arrowCol = abortTitle.indexOf('->');

check(!abortTitle.includes('('), 'title carries no abort marker');
check(
  abortRows.some((r) => r.kind === 'flags' && r.text.includes('aborted @ turn #7')),
  'abort gets its own arrow-aligned row'
);
check(
  abortRows.every((r) => r.kind === 'summary' || r.text.indexOf('->') === arrowCol),
  'every continuation row aligns on the summary arrow column'
);
check(
  composeLoopFlags({ ...abortLoop, outcome: 'completed', abortedAtTurn: null, toolErrors: 0, incompleteIntervals: 0 }) === '',
  'clean loop emits no flags row'
);
console.log('  aborted loop:');
for (const r of abortRows) console.log(`    |${r.text}|`);

// ── highlight invariants (colour must never change visible geometry) ──────
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, '');
const fakeTheme = {
  fg: (c, t) => `\x1b[38;5;5m${t}\x1b[39m`,
  bg: (c, t) => `\x1b[44m${t}\x1b[49m`,
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  underline: (t) => `\x1b[4m${t}\x1b[24m`,
  inverse: (t) => `\x1b[7m${t}\x1b[27m`,
};
const plainTitle = composeLoopString(wideLoop);
const headEnd = loopHeadEnd(plainTitle);
const transcriptStyled = styleLoopSummary(plainTitle, fakeTheme, 'transcript');
const statusStyled = styleLoopSummary(plainTitle, fakeTheme, 'status');

check(
  headEnd > 0 &&
    plainTitle.slice(0, headEnd).includes('turns') &&
    !plainTitle.slice(0, headEnd).includes('tool') &&
    plainTitle.slice(headEnd).startsWith(' / '),
  'head span covers LOOP title + turns + wall, stops before the tools group'
);
check(strip(transcriptStyled).length === plainTitle.length, 'transcript styling keeps visible width');
check(strip(statusStyled).length === plainTitle.length, 'status styling keeps visible width');
check(statusStyled.startsWith('\x1b[22m'), 'status mode closes pi\'s faint wrapper before the head');
check(statusStyled.includes('\x1b[38;5;5m') && statusStyled.slice(statusStyled.indexOf('\x1b[39m')).includes(' / '), 'tail stays outside the accent span');
check(styleLoopSummary(plainTitle, undefined, 'status') === plainTitle, 'no theme available -> falls back to plain text');

console.log(failures === 0 ? '  all display invariants hold' : `  ${failures} FAILED`);

// ── transcript rendering (loopstats entry renderer) ─────────────────────
console.log('\ntranscript entry render:');
const renderer = entryRenderers.get('loopstats');
if (!renderer) {
  console.log('  FAIL no loopstats entry renderer registered');
} else {
  const fakeTheme = { fg: (_c, t) => t };
  const entry = { type: 'custom', customType: 'loopstats', data: wideLoop };
  for (const expanded of [false, true]) {
    const component = renderer(entry, { expanded }, fakeTheme);
    const lines = component ? component.render(140) : [];
    check(Boolean(component), `renderer returns a component (expanded=${expanded})`);
    check(lines.some((l) => l.includes('->')), `drawn rows carry the arrow (expanded=${expanded})`);
    console.log(`  expanded=${expanded}:`);
    for (const line of lines) console.log(`    |${line}|`);
  }
}

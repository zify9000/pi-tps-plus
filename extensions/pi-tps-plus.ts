/**
 * pi-tps-plus — pi-tps fork with tool-execution timing and a per-loop summary
 *
 * Base: @monotykamary/pi-tps 1.3.11 (unmodified TPS / TTFT / stall / cost logic).
 *
 * Additions over upstream:
 *   1. Per-turn tool wall time: `tool X.Xs` appended to the turn banner.
 *      Measured as the UNION of [tool_execution_start → tool_execution_end]
 *      intervals, because pi executes a batch of tool calls in parallel
 *      (pi-agent-core executeToolCallsParallel) unless one tool declares
 *      executionMode: "sequential". Summing per-call durations would
 *      double-count parallel batches and report tool time > turn time.
 *   2. Per-loop summary at `agent_settled` (the final boundary of one user
 *      prompt, after all retries / follow-ups / steering have settled):
 *
 *        LOOP #3 -> 21 turns · 4m 12s / 63 tools · 3m 10s / in 200K · out 50K · 1m 3s / TPS 794.0
 *
 *      Loop TPS is output tokens ÷ Σ generationMs (the same generation clock
 *      the banner's per-turn TPS is derived from, but stalls stay inside the
 *      denominator, so a loop TPS is honestly lower than a good turn's TPS).
 *      `in` is the billed input: input + cacheRead + cacheWrite.
 *
 *      Persisted as customType 'loopstats'; reprint with /loopstats.
 *
 * Originally from: https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  // pi exports these, so import them instead of mirroring the internal .d.ts by
  // hand: a pi rename then fails a typecheck instead of silently shipping.
  TurnStartEvent,
  TurnEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  MessageEndEvent,
  SessionTreeEvent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
} from '@earendil-works/pi-coding-agent';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum gap between token updates to count as a stall (ms) */
const STALL_THRESHOLD_MS = 500;

/** pi-tps-plus: skip the banner's `tool` segment below this many milliseconds */
const TOOL_DISPLAY_MIN_MS = 50;

/**
 * pi-tps-plus: how the per-class tool breakdown is shown at settle time.
 *   'twoline' — summary line, then the breakdown indented on a second row
 *   'off'     — summary line only; get the breakdown via /loopstats
 * Both render through one notify because pi's status row is a single component
 * that the next status message replaces. 'inline' variants that cram everything
 * into one physical line are possible but read worse at terminal widths.
 */
const LOOP_TOOL_BREAKDOWN_STYLE: 'twoline' | 'off' = 'twoline';

/** pi-tps-plus: how many tool classes before collapsing the rest into `+N · time`. 0 = show all */
const LOOP_TOOL_BREAKDOWN_MAX = 6;

/** pi-tps-plus: append `(max …)` / `(!n)` flags to each class. Off keeps `count name · time`. */
const LOOP_TOOL_BREAKDOWN_FLAGS = false;

/**
 * pi-tps-plus: arrow prefix for the breakdown row, mirroring the summary row's `->`.
 * `'->'`  keeps the same glyph as row one; `'→'` / `'↳'` are single-column variants;
 * `''` puts the breakdown flush at the indent.
 */
const LOOP_TOOL_BREAKDOWN_ARROW = '->';

/**
 * pi-tps-plus: fold tool classes so the breakdown row fits the terminal instead of
 * hard-wrapping mid-token. The class cap is a ceiling; the width decides how many
 * of those classes actually get a row.
 */
const LOOP_TOOL_BREAKDOWN_FIT_WIDTH = true;

/**
 * pi-tps-plus: where the loop summary is drawn.
 *
 * pi has ONE status slot in the chat: `showStatus()` REPLACES the previous status
 * line whenever nothing else was appended to the chat (that is how pi-tps keeps a
 * single mutable per-turn TPS line). `agent_settled` always follows the last
 * `turn_end`, so notifying the loop summary there replaces — i.e. erases — the
 * freshest TPS line, and it only comes back when the next turn notifies again.
 *
 *   'transcript' (default) — draw it from the persisted `loopstats` entry via
 *       registerEntryRenderer(): its own component in the transcript, displaces
 *       nothing, survives resume and session replay, expandable.
 *   'notify'    — old behaviour: reuse the status slot (the last TPS line dies).
 *   'both'      — transcript component plus the status notify.
 *   'off'       — persist the entry only; see /loopstats.
 */
const LOOP_DISPLAY_TARGET: 'transcript' | 'notify' | 'both' | 'off' = 'transcript';

/**
 * pi-tps-plus: how the front of the summary row (from `LOOP #N` through
 * `N turns · wall`, i.e. everything before the first ` / `) is emphasized.
 * Theme tokens are used on purpose so the emphasis follows the active pi theme.
 *
 *   'accent'       theme accent colour for the head, rest stays dim  (recommended)
 *   'accentBold'   accent + bold — strongest legible option
 *   'bold'         intensity only, works on colour-less terminals
 *   'textContrast' head at normal intensity, rest dim: contrast only, no colour
 *   'inverse'      reverse video block — loudest, reads like a selection
 *   'underline'    reads like a link, avoid
 *   'bgSelected'   theme selection background, noisiest in a transcript
 *   'plain'        no emphasis
 * Compare them live: node ~/.pi/agent/dev/pi-tps-plus/demo-highlight.mjs
 */
const LOOP_HEAD_STYLE: 'accent' | 'accentBold' | 'bold' | 'textContrast' | 'inverse' | 'underline' | 'bgSelected' | 'plain' = 'accent';

/**
 * pi wraps every notify() message in dim (`theme.fg("dim", …)` = `\x1b[39m\x1b[2m …
 * \x1b[22;39m`), and SGR 2 stays active across an inner colour change, so a
 * highlighted head inside the status line would come out washed out. Emitting the
 * same SGR 22 pi itself uses to close faint restores full intensity for the head.
 * Only affects the notify channel; the transcript renderer owns its own colours.
 */
const LOOP_HEAD_UNDIM_IN_STATUS = true;

/** pi-tps-plus: a loop needs at least this much active generation time to report TPS */
const LOOP_TPS_MIN_GEN_MS = 100;

/**
 * pi-tps-plus: minimum per-turn active window counted toward loop TPS.
 * Matches upstream's MIN_GENERATION_MS gate: below this, the window is too
 * short to tell generation apart from a burst dispatch.
 */
const LOOP_MIN_MEASURABLE_MS = 200;

/** pi-tps-plus: same plausibility gate as the per-turn TPS, applied to the loop average */
const LOOP_MAX_PLAUSIBLE_TPS = 10_000;

/** Event name emitted by pi-neuralwatt-provider per turn with energy-billed cost data. */
const NEURALWATT_ENERGY_EVENT = 'neuralwatt:turn-energy';

// ─── Data types ─────────────────────────────────────────────────────────────

/** Structured telemetry persisted per turn in the session JSONL */
interface TurnTelemetry {
  model: { provider: string; modelId: string };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  timing: {
    ttftMs: number | null; // time to first token
    totalMs: number; // wall clock: turn_start → turn_end
    generationMs: number; // wall clock streaming time (message_start → message_end per message)
    streamMs: number | null; // inter-update span: first streaming update → last streaming update
    stallMs: number; // accumulated gaps > STALL_THRESHOLD_MS
    stallCount: number; // how many discrete stall events
    messageCount: number; // assistant messages in this turn
    toolMs: number; // pi-tps-plus: UNION of this turn's tool-execution intervals
    toolCalls: number; // pi-tps-plus: non-nested tool calls in this turn
  };
  tps: number | null; // output / (streamMs / 1000), null when burst/degenerate
  isPrimaryBranch: boolean; // TPS came from primary-branch (reliable) measurement
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  /**
   * Blended $/M-tokens rate shown in the notification banner: the per-turn
   * cost divided by (totalTokens / 1_000_000). Cost source is the Neuralwatt
   * billed cost when available (energy-based), otherwise the list-price
   * compute cost from `cost.total`. null when neither is usable or tokens
   * are zero. Purely derived — recomputed in composeDisplayString, not a
   * duplicate of the cost block.
   */
  rateUsdPerMTokens: number | null;
  timestamp: number;
}

/** In-memory state accumulated during one LLM turn */
interface TurnTiming {
  turnIndex: number;
  turnStartMs: number;
  lastUpdateMs: number;
  firstTokenMs: number | null;
  currentMessageStartMs: number | null;
  assistantMessages: AssistantMessage[];
  totalGenerationMs: number;
  // Inter-update TPS tracking: measures the streaming span between
  // the first and last non-TTFT message_update events.
  updateCount: number; // number of message_update events after the first (TTFT) one
  firstStreamUpdateMs: number | null; // timestamp of first non-TTFT update
  lastStreamUpdateMs: number; // timestamp of most recent non-TTFT update
  stallMs: number;
  stallCount: number;
  inStall: boolean;
  messageCount: number;
  isToolCall: boolean; // tool_execution_start fired during this turn
  isPrimaryBranch: boolean; // TPS came from primary-branch (reliable) measurement
  turnStartTimestamp: number; // wall-clock ms at turn_start, for correlating session energy entries
  tools: TurnToolStats; // pi-tps-plus
}

// ─── pi-tps-plus data types ─────────────────────────────────────────────────

/** One closed tool-execution window, in performance.now() units. */
interface ToolInterval {
  toolName: string;
  startMs: number;
  endMs: number;
  /** True when tool_execution_end never arrived (abort): closed at the boundary clock. */
  incomplete: boolean;
}

/** Tool-execution accounting for one LLM turn. */
interface TurnToolStats {
  intervals: ToolInterval[];
  calls: number; // non-nested calls only; nested ones are inside their parent's interval
  nestedCalls: number;
  errors: number;
}

/**
 * Per-tool-class totals for one loop.
 *
 * busyMs is Σ of that class's own call durations. Across classes these do NOT
 * sum to the loop's `toolMs` (interval union) when calls ran in parallel —
 * bash 2m31s + read 1.9s + edit 9.4s can exceed a 2m44s tool total. That is
 * expected, and is exactly what `toolBusyMs / toolMs` (parallelism) describes.
 */
interface ToolClassStats {
  count: number;
  busyMs: number; // Σ individual call durations of this class
  maxMs: number; // slowest single call of this class
  errors: number; // tool_execution_end.isError
}

/**
 * One loop = one user prompt and everything it caused, closed at agent_settled.
 * pi fires agent_start/agent_end per low-level run, so a retried or compacted
 * prompt is still ONE loop: the loop state is created lazily on the first
 * agent_start/turn_start after the previous loop settled.
 */
interface LoopStats {
  loopIndex: number;
  turns: number; // turn_start count in this loop
  wallMs: number; // loop creation → agent_settled
  genMs: number; // Σ per-turn generationMs
  toolMs: number; // Σ per-turn tool interval unions (turns never overlap)
  toolBusyMs: number; // Σ individual call durations → toolBusyMs / toolMs ≈ parallelism
  overheadMs: number; // wallMs - genMs - toolMs: provider queue, handler dispatch, compaction, gaps
  toolCalls: number;
  nestedToolCalls: number;
  toolErrors: number;
  incompleteIntervals: number;
  /** Stored for offline analysis / alternative rates; not part of the display line. */
  ttftMs: number; // Σ per-turn time to first token
  streamMs: number; // Σ per-turn pure streaming windows (TTFT- and stall-free)
  stallMs: number; // Σ inference stalls
  stallCount: number;
  /**
   * Loop TPS denominator/numerator, restricted to measurable turns.
   * A turn whose streaming window is unmeasurable (burst delivery, too few
   * chunks, stalls dominating) contributes its tokens to `tokens.output` but
   * NOT to this pair — otherwise free tokens over an empty window would inflate
   * the loop rate, which is exactly the artifact upstream nulls out per turn.
   */
  measuredOutput: number;
  activeGenMs: number; // Σ (streamMs - stallMs) over measurable turns
  /** Alternative rate, stored not displayed: full output ÷ full generationMs. */
  tpsGen: number | null;
  /** Per-class totals, keyed by toolName. Backs the tool breakdown display. */
  toolStats: Record<string, ToolClassStats>;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    billedInput: number; // input + cacheRead + cacheWrite
    total: number;
  };
  tps: number | null; // output / (genMs / 1000)
  costUsd: number | null;
  models: string[];
  outcome: 'completed' | 'aborted' | 'error';
  abortedAtTurn: number | null;
  startedAt: number; // wall-clock ms
  settledAt: number; // wall-clock ms
}

/** Mutable accumulator while a loop is running. */
interface LoopState extends LoopStats {
  settled: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the blended $/M-tokens rate: costUsd / (totalTokens / 1_000_000).
 * The single calculation backing the banner's $/M-tokens field. Returns null
 * when the inputs can't produce a meaningful rate (zero/negative tokens,
 * non-finite or negative cost).
 */
function computeRateUsdPerM(costUsd: number | null, totalTokens: number): number | null {
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) return null;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  const rate = costUsd / (totalTokens / 1_000_000);
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.round(rate * 100) / 100;
}

/**
 * Fallback: find a Neuralwatt energy entry that was persisted in this session
 * during the current turn. This covers the case where pi-neuralwatt-provider
 * loads before pi-tps, so the energy entry exists before our turn_end runs,
 * but the live event cache missed (e.g. malformed payload, event ordering, or
 * a race).
 *
 * Scans backward from the most recent entry and requires the entry timestamp
 * to be >= turnStartTimestamp so a previous turn's energy data is not reused.
 */
function findEnergyCostFromSession(
  ctx: ExtensionContext,
  turnStartTimestamp: number
): number | null {
  if (!ctx.sessionManager?.getEntries) return null;

  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'custom' || e.customType !== 'neuralwatt-energy') continue;

    const entryTimestamp = typeof e.timestamp === 'number' ? e.timestamp : 0;
    if (entryTimestamp < turnStartTimestamp) return null;

    const data = e.data as Record<string, unknown> | null | undefined;
    if (!data) continue;

    const costUsd = typeof data.cost_usd === 'number' ? data.cost_usd : null;
    if (costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0) return costUsd;
  }

  return null;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  if (msg.role !== 'assistant') return false;
  // Guard: ensure usage exists with required numeric fields before downstream access.
  if (typeof msg.usage !== 'object' || msg.usage === null) return false;
  const usage = msg.usage as Record<string, unknown>;
  if (typeof usage.input !== 'number' || typeof usage.output !== 'number') return false;
  return true;
}

/**
 * Format a number with human-readable scaling (K, M, B).
 * - Values < 1000: raw integer (e.g. 567 → "567")
 * - Values ≥ 1000: scaled with one decimal, dropping ".0" (e.g. 1234 → "1.2K", 2000 → "2K")
 * - Handles up to billions (e.g. 1_234_567_890 → "1.2B")
 */
function formatNumber(num: number): string {
  if (num < 1_000) return String(num);

  let value: number;
  let suffix: string;

  if (num >= 1_000_000_000) {
    value = num / 1_000_000_000;
    suffix = 'B';
  } else if (num >= 1_000_000) {
    value = num / 1_000_000;
    suffix = 'M';
  } else {
    value = num / 1_000;
    suffix = 'K';
  }

  // Drop trailing ".0" for clean display
  const formatted = value.toFixed(1);
  return formatted.endsWith('.0') ? `${value.toFixed(0)}${suffix}` : `${formatted}${suffix}`;
}

/**
 * Format duration in seconds to human-readable string.
 * Sub-minute values show 1 decimal (e.g. "2.3s" for TTFT precision).
 * Rules: no decimals, up to 2 units, includes years.
 * @internal Exported for testing only.
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const seconds = Math.round(totalSeconds);
  const units = [
    { label: 'y', seconds: 365 * 24 * 60 * 60 }, // 365 days
    { label: 'mo', seconds: 30 * 24 * 60 * 60 }, // 30 days
    { label: 'w', seconds: 7 * 24 * 60 * 60 },
    { label: 'd', seconds: 24 * 60 * 60 },
    { label: 'h', seconds: 60 * 60 },
    { label: 'm', seconds: 60 },
    { label: 's', seconds: 1 },
  ];

  const parts: { value: number; label: string }[] = [];
  let remaining = seconds;

  // First pass: extract all units with non-zero values
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (remaining >= unit.seconds) {
      const value = Math.floor(remaining / unit.seconds);
      parts.push({ value, label: unit.label });
      remaining %= unit.seconds;
    }
  }

  // If we only found one unit, add the next smaller unit as zero
  // Skip 'w' (weeks) when the primary unit is 'mo' (months) for better readability
  if (parts.length === 1) {
    const firstUnitIndex = units.findIndex((u) => u.label === parts[0].label);
    if (firstUnitIndex < units.length - 1) {
      let nextIndex = firstUnitIndex + 1;
      // Skip weeks when showing months, skip months+weeks when showing years —
      // go directly to days for a cleaner display
      if (parts[0].label === 'mo' && units[nextIndex].label === 'w') {
        nextIndex++;
      } else if (parts[0].label === 'y' && units[nextIndex].label === 'mo') {
        nextIndex += 2; // skip mo and w, land on d
      }
      if (nextIndex < units.length) {
        parts.push({ value: 0, label: units[nextIndex].label });
      }
    }
  }

  // Return up to 2 most significant units
  const top2 = parts.slice(0, 2);
  return top2.map((p) => `${p.value}${p.label}`).join(' ');
}

/**
 * pi-tps-plus: union of tool-execution intervals.
 *
 * pi executes one assistant message's tool calls concurrently
 * (executeToolCallsParallel) unless the batch contains a sequential-mode tool,
 * so all tool_execution_start events of a batch fire before any call finishes.
 * Σ(end - start) therefore double-counts overlapping calls and can exceed the
 * turn's wall clock. Merging overlapping intervals gives true wall time spent
 * on tools: equal to the sum when calls are serial, equal to the batch span
 * when they overlap.
 */
function unionToolMs(intervals: ToolInterval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let currentStart = sorted[0].startMs;
  let currentEnd = sorted[0].endMs;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.startMs > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = iv.startMs;
      currentEnd = iv.endMs;
    } else if (iv.endMs > currentEnd) {
      currentEnd = iv.endMs;
    }
  }
  total += currentEnd - currentStart;
  return Math.max(0, total);
}

/** pi-tps-plus: Σ of individual call durations (compare with union for parallelism). */
function busyToolMs(intervals: ToolInterval[]): number {
  let total = 0;
  for (const iv of intervals) total += iv.endMs - iv.startMs;
  return Math.max(0, total);
}

/** Guard for telemetry restored from session files written before pi-tps-plus. */
function readToolMs(timing: TurnTelemetry['timing'] | undefined): number {
  const value = (timing as Record<string, unknown> | undefined)?.toolMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * pi-tps-plus: per-tool-class breakdown line.
 *
 * Sorted by class busy time (slowest classes first), since the actionable
 * question is "what is costing me time", not "what did I use most".
 * `+N` collapses the remaining classes so the line cannot grow with tool variety.
 *
 * Class time is busy time (Σ of that class's own calls), so the classes do not
 * sum to the loop's union-based tool total whenever calls overlapped — that is
 * what the `∥N×` parallelism marker explains.
 */
export function composeToolBreakdown(
  s: LoopStats,
  maxClasses = LOOP_TOOL_BREAKDOWN_MAX,
  budgetColumns?: number
): string {
  const classes = Object.entries(s.toolStats)
    .filter(([, stats]) => stats.count > 0)
    .sort((a, b) => b[1].busyMs - a[1].busyMs || b[1].count - a[1].count);
  if (classes.length === 0) return '';

  // Count first: the numbers are what you scan, the name is what you read.
  const tokens = classes.map(([name, stats]) => {
    let token = `${stats.count} ${name} · ${formatDurationCompact(stats.busyMs / 1000)}`;
    if (LOOP_TOOL_BREAKDOWN_FLAGS) {
      // Long-tail flag only when it is actionable: one call dominating a class,
      // or one call slow enough to hunt down on its own.
      const dominates =
        stats.maxMs >= 20_000 || (stats.count >= 3 && stats.maxMs >= stats.busyMs * 0.5);
      if (dominates) token += ` (max ${formatDurationCompact(stats.maxMs / 1000)})`;
      if (stats.errors > 0) token += ` (!${stats.errors})`;
    }
    return token;
  });

  // Collapsed tail: `+N` is the number of classes folded away, the duration is their
  // combined busy time. Per-class counts stay in the persisted entry.
  const foldToken = (from: number): string[] => {
    const hidden = classes.slice(from);
    if (hidden.length === 0) return [];
    const hiddenBusy = hidden.reduce((total, [, stats]) => total + stats.busyMs, 0);
    return [`+${hidden.length} · ${formatDurationCompact(hiddenBusy / 1000)}`];
  };

  const render = (take: number): string =>
    [...tokens.slice(0, take), ...foldToken(take)].join(' / ');

  const ceiling = maxClasses > 0 ? Math.min(maxClasses, classes.length) : classes.length;
  let take = ceiling;
  // Width budget wins over the class cap, but never drops below the slowest class.
  if (budgetColumns !== undefined && LOOP_TOOL_BREAKDOWN_FIT_WIDTH) {
    while (take > 1 && render(take).length > budgetColumns) take--;
  }

  return render(take);
}

/**
 * pi-tps-plus: duration for the breakdown line — same scaling as formatDuration but
 * drops the pointless `.0` on sub-minute values (`10s`, not `10.0s`), matching the
 * convention formatNumber already follows for token counts.
 */
export function formatDurationCompact(totalSeconds: number): string {
  if (totalSeconds < 1) return `${Math.max(0, Math.round(totalSeconds * 1000))}ms`;
  return formatDuration(totalSeconds).replace(/(\d)\.0s$/, '$1s');
}

/**
 * pi-tps-plus: indent that lines up with the text right after the first line's
 * arrow. `LOOP #12 ->` and `LOOP #3 (aborted @ turn #7) ->` put the arrow at
 * different columns, so the indent is measured from the actual line instead of
 * hardcoded — that is what makes the breakdown look nested under the summary.
 */
export function arrowIndent(line: string, hasArrow = true): string {
  const at = line.indexOf(' -> ');
  if (at < 0) return '  ';
  // Line 1 contains `' -> '` — a space before the glyph — so the glyph column is
  // the match index + 1. Indenting to that column makes the two arrows line up;
  // indenting to at + 4 aligns with the summary's *text* instead.
  return ' '.repeat(hasArrow ? at + 1 : at + 4);
}

/**
 * pi-tps-plus: the full second row — indent, optional arrow, breakdown.
 * Kept in one helper because both the settle handler and /loopstats render it and
 * they must not drift apart.
 */
/**
 * pi-tps-plus: the anomaly rows (abort / tool errors / intervals that never closed).
 * Deliberately NOT part of the title: `LOOP #4 (aborted @ turn #7) ->` pushes the
 * arrow 28 columns right and buries the anomaly inside the metrics line. These are
 * read once, after the numbers, on their own arrow-aligned row.
 */
export function composeLoopFlags(s: LoopStats): string {
  const bits: string[] = [];
  if (s.outcome !== 'completed' || s.abortedAtTurn !== null) {
    bits.push(`${s.outcome === 'completed' ? 'aborted' : s.outcome} @ turn #${s.abortedAtTurn ?? s.turns}`);
  }
  if (s.toolErrors > 0) bits.push(`tool err ${s.toolErrors}`);
  if (s.incompleteIntervals > 0) bits.push(`unclosed ${s.incompleteIntervals}`);
  return bits.join(' · ');
}

/** A continuation row: aligned arrow, optional arrow glyph, then the payload. */
function arrowRow(summary: string, text: string): string {
  const arrow = LOOP_TOOL_BREAKDOWN_ARROW ? `${LOOP_TOOL_BREAKDOWN_ARROW} ` : '';
  return `${arrowIndent(summary, arrow !== '')}${arrow}${text}`;
}

export function composeToolBreakdownLine(summary: string, breakdown: string): string {
  if (!breakdown) return '';
  return arrowRow(summary, breakdown);
}

/**
 * pi-tps-plus: the fields the one-line summary cannot fit. Shown when the
 * loopstats transcript component is expanded (same toggle as tool output).
 */
export function formatLoopDetail(s: LoopStats): string {
  const bits: string[] = [];
  if (s.toolCalls > 0) {
    bits.push(`busy ${formatDurationCompact(s.toolBusyMs / 1000)}`);
    const parallelism = s.toolMs > 0 ? s.toolBusyMs / s.toolMs : 0;
    if (parallelism >= 1.2) bits.push(`∥${parallelism.toFixed(1)}×`);
  }
  if (s.ttftMs > 0) bits.push(`ttft ${formatDurationCompact(s.ttftMs / 1000)}`);
  if (s.stallCount > 0) bits.push(`stall ${formatDurationCompact(s.stallMs / 1000)}×${s.stallCount}`);
  bits.push(`overhead ${formatDurationCompact(s.overheadMs / 1000)}`);
  if (s.tpsGen !== null) bits.push(`tps(gen) ${s.tpsGen.toFixed(1)}`);
  if (s.nestedToolCalls > 0) bits.push(`nested ${s.nestedToolCalls}`);
  if (s.models.length > 0) bits.push(s.models.join(', '));
  if (s.costUsd !== null && s.costUsd !== undefined) bits.push(`$${s.costUsd.toFixed(4)}`);
  return bits.join(' · ');
}

/** pi-tps-plus: SGR 22 — closes faint/dim. pi's own dim wrapper ends with this. */
const UNDIM_ANSI = '\x1b[22m';

/** Index where the summary's front section ends: before the first tool group. */
export function loopHeadEnd(summary: string): number {
  return summary.indexOf(' / ');
}

function applyHeadStyle(text: string, theme: Theme): string {
  switch (LOOP_HEAD_STYLE) {
    case 'accent':
      return theme.fg('accent', text);
    case 'accentBold':
      return theme.fg('accent', theme.bold(text));
    case 'bold':
      return theme.bold(text);
    case 'textContrast':
      return theme.fg('text', text);
    case 'inverse':
      return theme.inverse(text);
    case 'underline':
      return theme.underline(text);
    case 'bgSelected':
      return theme.bg('selectedBg', text);
    case 'plain':
    default:
      return text;
  }
}

/**
 * pi-tps-plus: emphasise the front of the summary row (identity + turns + wall).
 *
 * mode 'transcript': we own the colours, so the tail is explicitly dim.
 * mode 'status': pi dims the whole notify payload, so the tail is left plain and
 *   the head is prefixed with SGR 22 to undo pi's faint wrapper.
 * Colours are added after all width maths, which always runs on plain text.
 */
export function styleLoopSummary(
  summary: string,
  theme: Theme | undefined,
  mode: 'transcript' | 'status'
): string {
  if (!theme || LOOP_HEAD_STYLE === 'plain') return summary;
  const cut = loopHeadEnd(summary);
  const head = cut > 0 ? summary.slice(0, cut) : summary;
  const tail = cut > 0 ? summary.slice(cut) : '';
  const prefix = mode === 'status' && LOOP_HEAD_UNDIM_IN_STATUS ? UNDIM_ANSI : '';
  const styledHead = applyHeadStyle(head, theme);
  const styledTail = mode === 'transcript' && tail ? theme.fg('dim', tail) : tail;
  return `${prefix}${styledHead}${styledTail}`;
}

/** Terminal width as seen by the extension; 80 when not attached to a TTY. */
export function terminalWidth(): number {
  const cols = typeof process !== 'undefined' ? process.stdout?.columns : undefined;
  return typeof cols === 'number' && cols >= 40 ? cols : 80;
}

/** Columns left for the breakdown after its indent and arrow are spent. */
export function breakdownBudget(summary: string): number {
  const arrow = LOOP_TOOL_BREAKDOWN_ARROW ? `${LOOP_TOOL_BREAKDOWN_ARROW} ` : '';
  return Math.max(20, terminalWidth() - arrowIndent(summary, arrow !== '').length - arrow.length);
}

/**
 * pi-tps-plus: the whole settle-time display for one loop — summary row plus the
 * width-aware breakdown row. One function so the settle handler and /loopstats
 * cannot drift apart.
 */
/**
 * pi-tps-plus: every row of one loop display, in order, tagged by kind so the
 * transcript renderer can color them differently:
 *   summary   → the metrics line
 *   breakdown → per-tool-class row (row 2)
 *   flags     → abort / tool errors / unclosed intervals (row 3)
 * Continuation rows all share the summary's arrow column.
 */
export function composeLoopRows(
  loop: LoopStats
): Array<{ text: string; kind: 'summary' | 'breakdown' | 'flags' }> {
  const summary = composeLoopString(loop);
  const rows: Array<{ text: string; kind: 'summary' | 'breakdown' | 'flags' }> = [
    { text: summary, kind: 'summary' },
  ];

  if (LOOP_TOOL_BREAKDOWN_STYLE !== 'off') {
    const breakdown = composeToolBreakdown(loop, LOOP_TOOL_BREAKDOWN_MAX, breakdownBudget(summary));
    const row = composeToolBreakdownLine(summary, breakdown);
    if (row) rows.push({ text: row, kind: 'breakdown' });
  }

  const flags = composeLoopFlags(loop);
  if (flags) rows.push({ text: arrowRow(summary, flags), kind: 'flags' });

  return rows;
}

export function renderLoopStats(loop: LoopStats, theme?: Theme): string {
  const rows = composeLoopRows(loop);
  return rows
    .map((row) =>
      row.kind === 'summary' ? styleLoopSummary(row.text, theme, 'status') : row.text
    )
    .join('\n');
}

/**
 * pi-tps-plus: compose the single-line loop summary.
 *
 *   LOOP #3 -> 21 turns · 4m 12s / 63 tools · 3m 10s / in 200K · out 50K · 1m 3s / TPS 794.0
 *
 * Three groups separated by `/`: wall clock / tool work / tokens+generation.
 * A loop with no tool calls drops the whole tool group instead of showing 0s.
 */
export function composeLoopString(s: LoopStats): string {
  const parts: string[] = [`LOOP #${s.loopIndex} -> ${s.turns} turn${s.turns === 1 ? '' : 's'}`];
  parts.push(`· ${formatDurationCompact(s.wallMs / 1000)}`);

  if (s.toolCalls > 0 || s.toolMs > 0) {
    parts.push(
      `/ ${s.toolCalls} tool${s.toolCalls === 1 ? '' : 's'} · ${formatDurationCompact(s.toolMs / 1000)}`
    );
  }

  parts.push(
    `/ in ${formatNumber(s.tokens.billedInput)} · out ${formatNumber(s.tokens.output)}`
  );
  parts.push(`· ${formatDurationCompact(s.genMs / 1000)}`);

  if (s.tps !== null) {
    parts.push(`/ TPS ${s.tps.toFixed(1)}`);
  }

  return parts.join(' ');
}

/**
 * Compose the human-readable display string from structured telemetry.
 */
function composeDisplayString(t: TurnTelemetry): string {
  const parts: string[] = [];
  parts.push(t.tps !== null ? `TPS ${t.tps.toFixed(1)} tok/s` : 'TPS —');
  if (t.timing.ttftMs !== null) {
    parts.push(`TTFT ${formatDuration(t.timing.ttftMs / 1000)}`);
  }
  parts.push(formatDuration(t.timing.totalMs / 1000));
  // pi-tps-plus: wall time this turn spent executing tools (interval union).
  // Below TOOL_DISPLAY_MIN_MS the number is noise, so the segment is dropped.
  const toolMs = readToolMs(t.timing);
  if (toolMs >= TOOL_DISPLAY_MIN_MS) {
    parts.push(`tool ${formatDuration(toolMs / 1000)}`);
  }
  parts.push(`in ${formatNumber(t.tokens.input)}`);
  parts.push(`out ${formatNumber(t.tokens.output)}`);
  if (t.timing.stallMs > 0) {
    const stallStr = formatDuration(t.timing.stallMs / 1000);
    parts.push(`stall ${stallStr}×${t.timing.stallCount}`);
  }
  if (t.rateUsdPerMTokens != null) {
    parts.push(`$${t.rateUsdPerMTokens.toFixed(2)}/M`);
  }
  return parts.join(' · ');
}

/**
 * Build structured TurnTelemetry from accumulated turn timing.
 * Returns null if the turn had no meaningful LLM output.
 */
function buildTelemetry(
  timing: TurnTiming,
  turnEndMs: number,
  billedCost: number | null = null
): TurnTelemetry | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;
  let hasCost = false;
  let model: { provider: string; modelId: string } | null = null;

  for (const message of timing.assistantMessages) {
    input += message.usage.input || 0;
    output += message.usage.output || 0;
    cacheRead += message.usage.cacheRead || 0;
    cacheWrite += message.usage.cacheWrite || 0;
    totalTokens += message.usage.totalTokens || 0;
    if (message.usage.cost) {
      costInput += message.usage.cost.input || 0;
      costOutput += message.usage.cost.output || 0;
      costCacheRead += message.usage.cost.cacheRead || 0;
      costCacheWrite += message.usage.cost.cacheWrite || 0;
      costTotal += message.usage.cost.total || 0;
      hasCost = true;
    }
    if (!model && message.provider && message.model) {
      model = { provider: message.provider, modelId: message.model };
    }
  }

  if (output <= 0) return null;
  if (!timing.firstTokenMs) return null;
  if (!model) return null;

  const totalMs = turnEndMs - timing.turnStartMs;

  // pi-tps-plus: tool wall time for this turn (interval union, so parallel
  // batches are not double-counted).
  const toolIntervals = timing.tools.intervals;
  const toolMs = unionToolMs(toolIntervals);
  const toolCalls = timing.tools.calls;

  // Inter-update TPS: measures the streaming span between the first and
  // last non-TTFT message_update events.
  //
  // Three-branch gate:
  //   Primary:   ≥5 updates, avg inter-chunk gap ≥1ms → streamMs is genuine
  //              generation timing, not buffer-flush dispatch overhead.
  //   Fallback:  ≥2 updates, totalGenerationMs ≥50ms → conservative rate
  //              using the full generation window (includes TTFT, so it
  //              underestimates — by design, to avoid overshooting).
  //   Else:      null — structurally unidentifiable.
  //
  // The avg inter-chunk gap is the key signal: buffer flushes dispatch
  // chunks with ~0.3–0.5ms gaps (network overhead only), while genuine
  // streaming at 3000 TPS with 5-token chunks has ~1.7ms gaps. A 1ms
  // threshold cleanly separates the two regimes without capping TPS by
  // magnitude — a legitimate 5000 TPS provider with 10-token chunks
  // still passes (2ms gaps), and future faster hardware with larger
  // batches passes too.
  const MIN_STREAM_MS = 1;
  const MIN_STREAM_UPDATES = 5;
  const MIN_INTER_CHUNK_MS = 1;
  const MIN_GENERATION_MS = 200;
  const ACTIVE_TIME_THRESHOLD_MS = 200;
  const STALL_REDUCTION_DENOM = 2;
  const STALL_DOMINANCE_RATIO = 0.85;

  // Maximum plausible generation speed (tokens/second). Beyond this, the
  // measured TPS is almost certainly a measurement artifact — the effective
  // generation window is too short relative to the token volume to
  // distinguish genuine inference from a buffer-flush dispatch of
  // pre-generated tokens. At 10_000 TPS this is 5× the fastest known
  // commercial inference (Cerebras ~2_000 tok/s). The gate is phrased as
  // "extraordinary claims require extraordinary evidence": for X output
  // tokens, the minimum reliable measurement window is X / MAX_PLAUSIBLE_TPS
  // seconds. Below that, the volume of tokens cannot be reliably timed, and
  // TPS is set to null. This is mathematically equivalent to nulling out
  // TPS when computed TPS > MAX_PLAUSIBLE_TPS.
  const MAX_PLAUSIBLE_TPS = 10_000;

  const streamMs =
    timing.updateCount > 0 && timing.firstStreamUpdateMs !== null
      ? timing.lastStreamUpdateMs - timing.firstStreamUpdateMs
      : null;

  const avgInterChunkGap =
    streamMs !== null && timing.updateCount > 1 ? streamMs / (timing.updateCount - 1) : 0;

  // ── Generation TPS ────────────────────────────────────────────────────
  // Raw inference speed: output / (active streaming time / 1000).
  // Excludes BOTH TTFT and known stalls — this is the speed at which the
  // model was actually producing tokens during active generation.
  //
  // The stall-before-stream bug: when a stall occurs between TTFT and the
  // first stream update, firstStreamUpdateMs is set AFTER the stall, making
  // streamMs only cover the post-stall burst. Subtracting stallMs from
  // streamMs gives the "active generation" span, but when stallMs ≥ streamMs
  // the result is unreliable — the post-stall cluster could be a buffer-flush
  // dispatch of pre-generated tokens, not sustained inference.
  //
  // Three guard conditions prevent inflation:
  //  1. stallMs < streamMs: prevents stall-before-stream where
  //     firstStreamUpdateMs lands AFTER the stall.
  //  2. effectiveStreamMs >= 50ms: the active span must be long enough to
  //     distinguish genuine generation from a dispatch artifact.
  //  3. stallMs < effectiveStreamMs: when stalls exceed active generation
  //     time (e.g. 998ms stall, 53ms active), the "active" span is likely
  //     a buffer-flush burst of pre-generated tokens, not sustained
  //     inference. Requiring stall time < active time ensures the
  //     streaming window is dominated by generation, not stalls.
  //
  // Three-branch gate:
  //   Primary:   all 3 guards pass → output / (effectiveStreamMs / 1000)
  //   Fallback:  ≥2 updates, generationMs ≥50ms
  //              → output / (effectiveGenMs / 1000)
  //              Includes TTFT, underestimates, but never overshoots.
  //   Else:      null — structurally unidentifiable.
  let tps: number | null = null;
  let isPrimaryBranch = false;
  if (
    streamMs !== null &&
    streamMs >= MIN_STREAM_MS &&
    timing.updateCount >= MIN_STREAM_UPDATES &&
    avgInterChunkGap >= MIN_INTER_CHUNK_MS &&
    timing.stallMs < streamMs && // stalls must not dominate streaming span
    streamMs - timing.stallMs >= MIN_GENERATION_MS && // effective span must be measurable
    timing.stallMs < streamMs - timing.stallMs // stall time < active time
  ) {
    // Active generation time: streaming window minus known stalls.
    // streamMs already excludes TTFT; subtracting stallMs gives the
    // time the model was actually generating tokens.
    const effectiveStreamMs = streamMs - timing.stallMs;
    const raw = output / (effectiveStreamMs / 1000);
    tps = Math.round(raw * 10) / 10;
    isPrimaryBranch = true;
  } else if (timing.updateCount >= 2 && timing.totalGenerationMs >= MIN_GENERATION_MS) {
    // Fallback: use generationMs (message_start → message_end) minus
    // stalls. This includes TTFT, so it underestimates generation speed,
    // but it's safe — no inflation possible.
    let effectiveGenMs = timing.totalGenerationMs - timing.stallMs;
    const stallsDominate =
      effectiveGenMs < ACTIVE_TIME_THRESHOLD_MS ||
      timing.stallMs > timing.totalGenerationMs * STALL_DOMINANCE_RATIO;
    if (stallsDominate) {
      effectiveGenMs = Math.max(
        timing.totalGenerationMs - timing.stallMs / STALL_REDUCTION_DENOM,
        MIN_GENERATION_MS
      );
    } else {
      effectiveGenMs = Math.max(effectiveGenMs, MIN_GENERATION_MS);
    }
    const raw = output / (effectiveGenMs / 1000);
    tps = Math.round(raw * 10) / 10;
  } else {
    tps = null;
  }

  // Volume-based sanity gate: extraordinary TPS claims require
  // proportionally longer measurement windows. When a provider emits a
  // large volume of tokens in a short time window, the measured rate is
  // dominated by dispatch/buffer-flush timing rather than actual inference
  // speed. For X output tokens, the minimum reliable generation window is
  // X / MAX_PLAUSIBLE_TPS seconds — below that, the volume of tokens cannot
  // be reliably timed, and TPS is set to null.
  //
  // Mathematically equivalent to: computed TPS > MAX_PLAUSIBLE_TPS → null.
  // But phrased as a measurement-reliability principle: the evidence
  // (effective window duration) must be proportional to the claim (token
  // volume ÷ inferred rate).
  if (tps !== null && tps > MAX_PLAUSIBLE_TPS) {
    tps = null;
    isPrimaryBranch = false;
  }

  // Single blended $/M-tokens rate for the banner. Cost source: Neuralwatt's
  // billed cost when present (energy-based, what the user actually pays),
  // otherwise the list-price compute cost from message.usage.cost. Never both
  // — billedCost wins outright when present, so there's no double-counting.
  // Pi represents models without pricing with an all-zero cost block. Treat
  // that as unavailable rather than displaying a misleading $0.00/M rate. An
  // explicit billed cost remains valid even when it is zero.
  const listPriceCost = hasCost && Number.isFinite(costTotal) && costTotal > 0 ? costTotal : null;
  const effectiveCost = billedCost ?? listPriceCost;
  const rateUsdPerMTokens = computeRateUsdPerM(effectiveCost, totalTokens);

  return {
    model,
    tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
    timing: {
      ttftMs: timing.firstTokenMs - timing.turnStartMs,
      totalMs,
      generationMs: timing.totalGenerationMs,
      streamMs,
      stallMs: timing.stallMs,
      stallCount: timing.stallCount,
      messageCount: timing.messageCount,
      toolMs,
      toolCalls,
    },
    tps,
    isPrimaryBranch,
    cost:
      listPriceCost !== null
        ? {
            input: costInput,
            output: costOutput,
            cacheRead: costCacheRead,
            cacheWrite: costCacheWrite,
            total: costTotal,
          }
        : null,
    rateUsdPerMTokens,
    timestamp: Date.now(),
  };
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function tpsExtension(pi: ExtensionAPI) {
  // Current turn timing state
  let currentTiming: TurnTiming | null = null;

  // Per-model TPS cap: highest reliable (primary-branch, non-tool-call) TPS observed.
  // Tool-call turns get clamped to this value. Only set by reliable streaming measurements.
  const tpsCaps = new Map<string, number>(); // "provider:modelId" → cap

  // Cached session entries for argument completion (captured on session_start / session_tree)
  let cachedEntries: Array<{ type?: string; customType?: string; data?: unknown }> = [];

  // pi-neuralwatt-provider emits billed cost during its turn_end handler. Keep
  // an early event only for the active turn; a late event corrects only the
  // turn that was just committed. turnIndex resets to zero on every agent run,
  // so billed costs must never survive beyond either of those scopes.
  let pendingNeuralwattBilledCost: { turnIndex: number; costUsd: number } | null = null;

  let lastCommittedTurn: {
    turnIndex: number;
    telemetry: TurnTelemetry;
    billedApplied: boolean;
    ctx: ExtensionContext;
  } | null = null;

  // ── pi-tps-plus loop state ────────────────────────────────────────────────

  /**
   * One loop = one user prompt plus everything it caused, closed at agent_settled.
   * pi fires agent_start/agent_end per low-level run, so retries, overflow
   * recovery, compaction retries, steering and follow-ups all stay inside the
   * SAME loop: the state is created lazily by the first agent_start/turn_start
   * after the previous loop settled.
   */
  let activeLoop: LoopState | null = null;
  let loopCounter = 0; // highest loopIndex observed; restored from persisted entries on resume
  let lastLoopStats: LoopStats | null = null;
  let loopOutcome: LoopStats['outcome'] = 'completed';
  let lastTurnIndex = 0;
  let loopStartClockMs = 0; // performance.now() at loop creation
  let pendingLoopIntervals: ToolInterval[] = []; // tool calls that happened outside any tracked turn
  const openToolCalls = new Map<string, { startMs: number; toolName: string; nested: boolean }>();

  function ensureLoop(): LoopState {
    if (activeLoop) return activeLoop;
    loopCounter += 1;
    loopStartClockMs = performance.now();
    loopOutcome = 'completed';
    pendingLoopIntervals = [];
    openToolCalls.clear();
    activeLoop = {
      loopIndex: loopCounter,
      turns: 0,
      wallMs: 0,
      genMs: 0,
      toolMs: 0,
      toolBusyMs: 0,
      overheadMs: 0,
      toolCalls: 0,
      nestedToolCalls: 0,
      toolErrors: 0,
      incompleteIntervals: 0,
      ttftMs: 0,
      streamMs: 0,
      stallMs: 0,
      stallCount: 0,
      measuredOutput: 0,
      activeGenMs: 0,
      tpsGen: null,
      toolStats: {},
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billedInput: 0, total: 0 },
      tps: null,
      costUsd: null,
      models: [],
      outcome: 'completed',
      abortedAtTurn: null,
      startedAt: Date.now(),
      settledAt: 0,
      settled: false,
    };
    return activeLoop;
  }

  /** Attribute a closed tool window to the active turn, or to the loop when it fell between turns. */
  function recordToolInterval(interval: ToolInterval): void {
    if (currentTiming) {
      currentTiming.tools.intervals.push(interval);
      return;
    }
    pendingLoopIntervals.push(interval);
  }

  /** Per-class totals. Runs for both completed and truncated calls so counts stay true. */
  function recordToolClass(toolName: string, durationMs: number, isError: boolean): void {
    const loop = ensureLoop();
    const stats = (loop.toolStats[toolName] ??= { count: 0, busyMs: 0, maxMs: 0, errors: 0 });
    stats.count += 1;
    stats.busyMs += durationMs;
    if (durationMs > stats.maxMs) stats.maxMs = durationMs;
    if (isError) stats.errors += 1;
  }

  /**
   * Close tool calls whose tool_execution_end never arrived (abort, crash,
   * cancelled stream). Truncating at the boundary clock keeps the tool clock
   * from silently swallowing an aborted run's tool time.
   */
  function closeOpenToolCalls(atMs: number): void {
    for (const [toolCallId, open] of openToolCalls) {
      openToolCalls.delete(toolCallId);
      if (open.nested) continue;
      if (atMs <= open.startMs) continue;
      recordToolClass(open.toolName, atMs - open.startMs, false);
      recordToolInterval({
        toolName: open.toolName,
        startMs: open.startMs,
        endMs: atMs,
        incomplete: true,
      });
      if (activeLoop) activeLoop.incompleteIntervals += 1;
    }
  }

  function finalizeLoop(atMs: number, ctx: ExtensionContext): void {
    const loop = activeLoop;
    if (!loop || loop.settled) return;

    closeOpenToolCalls(atMs);

    if (pendingLoopIntervals.length > 0) {
      loop.toolMs += unionToolMs(pendingLoopIntervals);
      loop.toolBusyMs += busyToolMs(pendingLoopIntervals);
      pendingLoopIntervals = [];
    }

    loop.outcome = loopOutcome;
    if (loop.outcome !== 'completed' || loop.incompleteIntervals > 0) {
      loop.abortedAtTurn = lastTurnIndex;
    }
    loop.wallMs = Math.max(0, atMs - loopStartClockMs);
    loop.settledAt = Date.now();
    loop.overheadMs = Math.max(0, loop.wallMs - loop.genMs - loop.toolMs);

    // Loop TPS = measured output ÷ active generation window, aggregated over
    // measurable turns only. This is the loop-level analogue of the banner's
    // per-turn primary-branch rate: TTFT is excluded (streamMs starts at the
    // first post-TTFT update) and inference stalls are subtracted, so the
    // number is generation speed rather than wall-clock throughput.
    loop.tps =
      loop.measuredOutput > 0 && loop.activeGenMs >= LOOP_TPS_MIN_GEN_MS
        ? Math.round((loop.measuredOutput / (loop.activeGenMs / 1000)) * 10) / 10
        : null;
    if (loop.tps !== null && loop.tps > LOOP_MAX_PLAUSIBLE_TPS) loop.tps = null;

    // Reference rate kept in the entry only: the same loop measured against the
    // full generation window, which still contains TTFT and stalls.
    loop.tpsGen =
      loop.tokens.output > 0 && loop.genMs >= LOOP_TPS_MIN_GEN_MS
        ? Math.round((loop.tokens.output / (loop.genMs / 1000)) * 10) / 10
        : null;
    if (loop.tpsGen !== null && loop.tpsGen > LOOP_MAX_PLAUSIBLE_TPS) loop.tpsGen = null;

    loop.settled = true;
    activeLoop = null;

    if (loop.turns === 0) return; // nothing measurable happened

    lastLoopStats = loop;
    // `settled` is runtime bookkeeping, not telemetry: keep it out of the session entry.
    const { settled, ...persisted } = loop;
    pi.appendEntry('loopstats', persisted);
    pi.events?.emit('tps:loop', persisted);
    cachedEntries.push({ type: 'custom', customType: 'loopstats' });

    if (ctx.hasUI && (LOOP_DISPLAY_TARGET === 'notify' || LOOP_DISPLAY_TARGET === 'both')) {
      // One notify, not two: pi's status slot is a single component and the next
      // status message replaces it, so the loop summary would erase this loop's
      // last per-turn TPS line. That is why the default path is the entry renderer.
      ctx.ui.notify(renderLoopStats(loop, ctx.ui.theme), 'info');
    }
  }

  /**
   * pi-tps-plus: rebuild loop numbering and the reprintable summary from the
   * active branch. Abandoned branches are excluded on purpose — looping over
   * getEntries() would count turns that never happened in this history.
   * Deliberately does NOT notify, so the restored per-turn TPS banner stays visible.
   */
  function restoreLoopState(ctx: ExtensionContext): void {
    lastLoopStats = null;
    let maxIndex = 0;
    const entries = ctx.sessionManager.getBranch?.() ?? [];
    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== 'loopstats') continue;
      const data = entry.data as LoopStats | null;
      if (!data || typeof data.loopIndex !== 'number') continue;
      if (data.loopIndex > maxIndex) maxIndex = data.loopIndex;
      lastLoopStats = data;
    }
    loopCounter = Math.max(loopCounter, maxIndex);
  }


  pi.events?.on(NEURALWATT_ENERGY_EVENT, (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    const turnIndex = typeof p.turnIndex === 'number' ? p.turnIndex : null;
    const costUsd = typeof p.costUsd === 'number' ? p.costUsd : null;
    if (turnIndex === null || costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) {
      return;
    }

    // Provider loaded before pi-tps: turn_end has not reached us yet.
    if (currentTiming) {
      if (currentTiming.turnIndex === turnIndex) {
        pendingNeuralwattBilledCost = { turnIndex, costUsd };
      }
      return;
    }

    // Provider loaded after pi-tps: correct the turn we just committed. Do not
    // cache this event; the same turnIndex can belong to the next agent run.
    const committed = lastCommittedTurn;
    if (!committed || committed.billedApplied || committed.turnIndex !== turnIndex) return;

    committed.billedApplied = true;
    const correctedRate = computeRateUsdPerM(costUsd, committed.telemetry.tokens.total);
    if (correctedRate === null || correctedRate === committed.telemetry.rateUsdPerMTokens) return;

    const corrected = { ...committed.telemetry, rateUsdPerMTokens: correctedRate };
    committed.telemetry = corrected;
    pi.appendEntry('tps', corrected);
    pi.events?.emit('tps:telemetry', corrected);
    cachedEntries.push({ type: 'custom', customType: 'tps' });
    if (committed.ctx.hasUI) {
      committed.ctx.ui.notify(composeDisplayString(corrected), 'info');
    }
  });

  // ── Rehydration ─────────────────────────────────────────────────────────

  /**
   * Restore the most recent TPS notification on resume.
   * Supports both structured (TurnTelemetry) and legacy ({ message, timestamp })
   * entries for backwards compatibility with older session files.
   * Deferred via setTimeout so it survives TUI clear+rebuild.
   */
  function restoreTPSNotification(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === 'custom' && entry.customType === 'tps') {
        const data = entry.data as Record<string, unknown> | null;
        if (!data) continue;
        // Structured format (current): has model field
        if (data.model) {
          const message = composeDisplayString(data as unknown as TurnTelemetry);
          setTimeout(() => {
            ctx.ui.notify(message, 'info');
          }, 0);
          break;
        }
        // Legacy format: { message: string, timestamp: number }
        if (typeof data.message === 'string') {
          setTimeout(() => {
            ctx.ui.notify(data.message as string, 'info');
          }, 0);
          break;
        }
      }
    }
  }

  // Restore notification on session start/resume — skip only brand-new sessions
  pi.on('session_start', (_event, ctx) => {
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSNotification(ctx);
    restoreLoopState(ctx);
  });

  // Restore notification after /tree navigation (same session, different branch)
  pi.on('session_tree', (_event: SessionTreeEvent, ctx: ExtensionContext) => {
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    activeLoop = null;
    openToolCalls.clear();
    pendingLoopIntervals = [];
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSNotification(ctx);
    restoreLoopState(ctx);
  });

  // ── pi-tps-plus loop boundaries ───────────────────────────────────────────

  // Fires per low-level run, so a retried/compacted run continues the loop that
  // is already open instead of starting a new one.
  pi.on('agent_start', () => {
    ensureLoop();
  });

  // Any tool call still open when a run ends will never receive tool_execution_end.
  // Close it now so its time is not lost, and so it cannot leak into the next run.
  pi.on('agent_end', () => {
    closeOpenToolCalls(performance.now());
  });

  // Final boundary of one user prompt: all turns, retries, follow-ups and steering
  // have settled. This is where the single-line loop summary belongs.
  // (No agent_before_settle handler: registering one would force pi to build the
  // pre-settle boundary context on every run just to read `outcome`, which
  // turn_end already reports for free.)
  pi.on('agent_settled', (_event, ctx) => {
    finalizeLoop(performance.now(), ctx);
  });

  // ── Turn timing ─────────────────────────────────────────────────────────

  // Track when a turn starts (request sent to LLM)
  pi.on('turn_start', (_event: TurnStartEvent) => {
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    lastTurnIndex = _event.turnIndex;
    const loop = ensureLoop();
    loop.turns += 1;
    currentTiming = {
      turnIndex: _event.turnIndex,
      turnStartMs: performance.now(),
      turnStartTimestamp: typeof _event.timestamp === 'number' ? _event.timestamp : Date.now(),
      lastUpdateMs: performance.now(),
      firstTokenMs: null,
      currentMessageStartMs: null,
      assistantMessages: [],
      totalGenerationMs: 0,
      updateCount: 0,
      firstStreamUpdateMs: null,
      lastStreamUpdateMs: 0,
      stallMs: 0,
      stallCount: 0,
      inStall: false,
      messageCount: 0,
      isToolCall: false,
      isPrimaryBranch: false,
      tools: { intervals: [], calls: 0, nestedCalls: 0, errors: 0 },
    };
  });

  // Track when a message starts. In pi, message_start fires at stream
  // creation (before any tokens), so we defer TTFT to the first
  // message_update which carries the first real token.
  pi.on('message_start', (event: MessageStartEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // Track when THIS message started streaming (for generation TPS)
    currentTiming.currentMessageStartMs = now;
    currentTiming.messageCount++;

    // Reset stall-tracking clock so tool-execution gaps between
    // messages don't get counted as inference stalls.
    currentTiming.lastUpdateMs = now;
    currentTiming.inStall = false;
  });

  // Track token-by-token updates during streaming (real-time TPS & stall detection).
  // The first message_update is the effective first token (message_start fires
  // at stream creation, before any content arrives).
  pi.on('message_update', (event: MessageUpdateEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // First token: capture TTFT and seed stall timing, then bail.
    // No stall detection on this event — the gap from message_start to
    // first message_update is provider parsing overhead, not a stall.
    if (currentTiming.firstTokenMs === null) {
      currentTiming.firstTokenMs = now;
      currentTiming.lastUpdateMs = now;
      return;
    }

    // Track inter-update streaming span for TPS calculation
    currentTiming.updateCount++;
    if (currentTiming.firstStreamUpdateMs === null) {
      currentTiming.firstStreamUpdateMs = now;
    }
    currentTiming.lastStreamUpdateMs = now;

    const gap = now - currentTiming.lastUpdateMs;

    // Detect stall: gap exceeds threshold. The full gap counts as stall
    // time — the threshold is a detection gate, not a duration discount.
    if (gap >= STALL_THRESHOLD_MS) {
      if (!currentTiming.inStall) {
        currentTiming.stallCount++;
      }
      currentTiming.inStall = true;
      currentTiming.stallMs += gap;
    } else {
      currentTiming.inStall = false;
    }

    currentTiming.lastUpdateMs = now;
  });

  // Track when a tool starts executing — marks this turn as a tool call
  // for the dynamic TPS cap (tool-call turns only get capped, never set the cap).
  // pi-tps-plus: also opens the tool's timing window.
  pi.on('tool_execution_start', (event: ToolExecutionStartEvent) => {
    if (!currentTiming) return;
    currentTiming.isToolCall = true;

    // Nested calls (ctx.executeTool from a codemode script) sit entirely inside
    // their parent's window: counting them would double the tool time and
    // inflate per-tool counts, so only their count is recorded.
    const nested = typeof event.parentToolCallId === 'string';
    openToolCalls.set(event.toolCallId, {
      startMs: performance.now(),
      toolName: event.toolName,
      nested,
    });

    const loop = ensureLoop();
    if (nested) loop.nestedToolCalls += 1;
    else loop.toolCalls += 1;
    if (nested) currentTiming.tools.nestedCalls += 1;
    else currentTiming.tools.calls += 1;
  });

  // pi-tps-plus: close the tool window. Intervals of one batch overlap (pi runs
  // them in parallel), which is why only a union is a valid turn total.
  pi.on('tool_execution_end', (event: ToolExecutionEndEvent) => {
    const open = openToolCalls.get(event.toolCallId);
    if (!open) return;
    openToolCalls.delete(event.toolCallId);

    const loop = ensureLoop();
    if (event.isError) loop.toolErrors += 1;
    if (currentTiming && event.isError) currentTiming.tools.errors += 1;

    if (open.nested) return;

    const now = performance.now();
    const durationMs = Math.max(0, now - open.startMs);
    // Class totals include zero-length calls: an intercepted or instant call is
    // still a call, it just has no measurable time.
    recordToolClass(open.toolName, durationMs, event.isError);
    if (durationMs === 0) return;
    recordToolInterval({
      toolName: open.toolName,
      startMs: open.startMs,
      endMs: now,
      incomplete: false,
    });
  });

  // Track when a message ends
  pi.on('message_end', (event: MessageEndEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // Accumulate ACTUAL streaming time for this message (true generation time)
    if (currentTiming.currentMessageStartMs) {
      const messageGenerationMs = now - currentTiming.currentMessageStartMs;
      currentTiming.totalGenerationMs += messageGenerationMs;
      currentTiming.currentMessageStartMs = null;
    }

    // Store this message to count its tokens later (only current turn's messages)
    currentTiming.assistantMessages.push(event.message);
    currentTiming.lastUpdateMs = now;
  });

  // ── Persist telemetry ───────────────────────────────────────────────────

  // Calculate, display, and persist telemetry at the end of each LLM turn.
  // The Neuralwatt listener stores an early billed cost only while this exact
  // turn is active, so the handoff remains synchronous and adds no latency.
  pi.on('turn_end', (event: TurnEndEvent, ctx: ExtensionContext) => {
    if (!currentTiming) return;

    const timing = currentTiming;
    currentTiming = null;

    const turnEndMs = performance.now();

    // Pick the effective cost for the blended $/M-tokens rate: Neuralwatt's
    // billed cost when present, otherwise the list-price compute cost from
    // message.usage.cost. The live event is the primary source; if it missed,
    // we read the persisted neuralwatt-energy session entry. Only if neither
    // energy source is available do we fall back to the compute rate.
    // Prefer the live energy event, fall back to the persisted energy entry,
    // and finally to the list-price compute cost.
    let billedCost =
      pendingNeuralwattBilledCost?.turnIndex === event.turnIndex
        ? pendingNeuralwattBilledCost.costUsd
        : null;
    pendingNeuralwattBilledCost = null;

    if (billedCost === null && timing.turnStartTimestamp) {
      billedCost = findEnergyCostFromSession(ctx, timing.turnStartTimestamp);
    }

    const telemetry = buildTelemetry(timing, turnEndMs, billedCost);

    // pi-tps-plus: why this turn ended. The LAST settled turn decides the loop's
    // outcome, and an aborted turn is exactly the one worth timestamping.
    const turnOutcome = event.outcome ?? 'completed';
    if (turnOutcome !== 'completed') {
      loopOutcome = turnOutcome;
      lastTurnIndex = event.turnIndex;
    }

    // ── pi-tps-plus: fold this turn into the loop accumulator ────────────
    // Runs before telemetry can be discarded: a turn pi-tps refuses to display
    // (zero output, no first token, no model) still consumed wall time, tool
    // time and tokens, and the loop total must stay honest about that.
    const loop = ensureLoop();
    loop.toolMs += unionToolMs(timing.tools.intervals);
    loop.toolBusyMs += busyToolMs(timing.tools.intervals);
    loop.genMs += timing.totalGenerationMs;
    // Stored but not displayed: lets /tps-export style analysis recompute an
    // alternative loop TPS (out / streamMs) without re-running the loop.
    if (timing.firstTokenMs !== null) loop.ttftMs += timing.firstTokenMs - timing.turnStartMs;
    if (timing.updateCount > 0 && timing.firstStreamUpdateMs !== null) {
      const turnStreamMs = timing.lastStreamUpdateMs - timing.firstStreamUpdateMs;
      loop.streamMs += turnStreamMs;
      // Measurable window: pure streaming minus inference stalls, long enough to
      // distinguish sustained generation from a single buffer-flush dispatch.
      const activeMs = turnStreamMs - timing.stallMs;
      if (activeMs >= LOOP_MIN_MEASURABLE_MS) {
        loop.activeGenMs += activeMs;
        let turnOutput = 0;
        for (const message of timing.assistantMessages) {
          turnOutput += (message.usage as Record<string, number>).output || 0;
        }
        loop.measuredOutput += turnOutput;
      }
    }
    loop.stallMs += timing.stallMs;
    loop.stallCount += timing.stallCount;

    for (const message of timing.assistantMessages) {
      const usage = message.usage as Record<string, number>;
      loop.tokens.input += usage.input || 0;
      loop.tokens.output += usage.output || 0;
      loop.tokens.cacheRead += usage.cacheRead || 0;
      loop.tokens.cacheWrite += usage.cacheWrite || 0;
      loop.tokens.total += usage.totalTokens || 0;
      if (message.provider && message.model) {
        const key = `${message.provider}:${message.model}`;
        if (!loop.models.includes(key)) loop.models.push(key);
      }
    }
    loop.tokens.billedInput =
      loop.tokens.input + loop.tokens.cacheRead + loop.tokens.cacheWrite;

    if (telemetry?.cost) {
      loop.costUsd = (loop.costUsd ?? 0) + (telemetry.cost.total || 0);
    }

    if (!telemetry) return;

    // ── Dynamic TPS cap ────────────────────────────────────────────────
    // Only non-tool-call, primary-branch (reliable) measurements set the cap.
    // Tool-call turns get clamped to the cap to prevent inflation from
    // short outputs over tiny time windows.
    const modelKey = `${telemetry.model.provider}:${telemetry.model.modelId}`;

    if (telemetry.isPrimaryBranch && telemetry.tps !== null) {
      const currentCap = tpsCaps.get(modelKey);
      if (currentCap === undefined || telemetry.tps > currentCap) {
        tpsCaps.set(modelKey, telemetry.tps);
      }
    }

    if (timing.isToolCall && telemetry.tps !== null) {
      const cap = tpsCaps.get(modelKey);
      if (cap !== undefined) {
        telemetry.tps = Math.min(telemetry.tps, cap);
      } else {
        telemetry.tps = null;
      }
    }

    // Record this turn so a late-arriving neuralwatt:turn-energy event
    // (provider loaded after us) can retroactively correct the rate. Billed
    // cost wins when present, so a turn already billed at commit time is
    // never re-corrected.
    lastCommittedTurn = {
      turnIndex: event.turnIndex,
      telemetry,
      billedApplied: billedCost !== null,
      ctx,
    };

    // Persist structured telemetry to session for export and rehydration
    pi.appendEntry('tps', telemetry);

    // Emit event so other extensions can react to new telemetry
    pi.events.emit('tps:telemetry', telemetry);

    // Show notification only when UI is available
    if (ctx.hasUI) {
      const message = composeDisplayString(telemetry);
      ctx.ui.notify(message, 'info');
    }

    // Keep argument completion cache in sync with new entries
    cachedEntries.push({ type: 'custom', customType: 'tps' });
  });

  // ── pi-tps-plus: loop summary command ─────────────────────────────────

  pi.registerCommand('loopstats', {
    description: 'Show the loop summary line (latest loop; --all lists every loop on this branch)',
    getArgumentCompletions: (argumentPrefix: string) => {
      if ('--all'.startsWith(argumentPrefix)) {
        return [{ value: '--all', label: '--all (every loop on the current branch)' }];
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const all = args.trim().split(/\s+/).includes('--all');

      const loops: LoopStats[] = [];
      for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
        if (entry.type !== 'custom' || entry.customType !== 'loopstats') continue;
        const data = entry.data as LoopStats | null;
        if (data && typeof data.loopIndex === 'number') loops.push(data);
      }

      const latest = loops.length > 0 ? loops[loops.length - 1] : lastLoopStats;

      if (!all) {
        if (!latest) {
          ctx.ui.notify('No loop summary recorded in this session yet', 'warning');
          return;
        }
        ctx.ui.notify(renderLoopStats(latest, ctx.ui.theme), 'info');
        return;
      }

      if (loops.length === 0) {
        ctx.ui.notify('No loop summaries in this session', 'warning');
        return;
      }

      const lines = loops.map((loop) => composeLoopString(loop));
      const shown = lines.slice(-12);
      const omitted = lines.length - shown.length;
      const header =
        omitted > 0 ? `${loops.length} loops (last ${shown.length} shown)` : `${loops.length} loops`;
      ctx.ui.notify([header, ...shown].join('\n'), 'info');
    },
  });

  // ── pi-tps-plus: draw the loop summary in the transcript ─────────────────
  //
  // The `loopstats` entry was already appended; without a renderer it was invisible.
  // Rendering it here keeps the summary out of pi's single status slot, so the
  // per-turn TPS line the user is watching is never displaced, and the loop lines
  // stay scrollable and re-appear on resume / session replay.
  pi.registerEntryRenderer<LoopStats>('loopstats', (entry, { expanded }, theme) => {
    if (LOOP_DISPLAY_TARGET === 'off') return undefined;
    const loop = entry.data;
    if (!loop || typeof loop.loopIndex !== 'number') return undefined;

    const rows = composeLoopRows(loop).map((row) => {
      // Aborts and tool errors deserve to be seen, not to be dim like the metrics.
      if (row.kind === 'flags') return theme.fg('warning', row.text);
      if (row.kind === 'breakdown') return theme.fg('dim', row.text);
      return styleLoopSummary(row.text, theme, 'transcript');
    });
    if (expanded) rows.push(theme.fg('muted', `  ${formatLoopDetail(loop)}`));

    // paddingX applies to every row equally, so the arrow alignment survives it.
    return new Text(rows.join('\n'), 1, 0);
  });

  // ── Export commands ─────────────────────────────────────────────────────

  pi.registerCommand('tps-export', {
    description:
      'Export telemetry + session structure (model changes, branch points) as JSONL (--full for all branches, filter by customType)',
    getArgumentCompletions: (argumentPrefix: string) => {
      // Offer --full flag
      if ('--full'.startsWith(argumentPrefix)) {
        return [{ value: '--full', label: '--full (all branches, not just current)' }];
      }
      // Collect all unique customType values from cached session entries
      const customTypes = new Set<string>();
      for (const entry of cachedEntries) {
        if (entry.type === 'custom' && entry.customType) {
          customTypes.add(entry.customType);
        }
      }
      return Array.from(customTypes)
        .filter((ct) => ct.startsWith(argumentPrefix))
        .map((ct) => ({ value: ct, label: ct }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // Default: current branch. --full: entire session.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const full = tokens.includes('--full');
      const filterType = tokens.filter((t) => t !== '--full').join(' ') || null;

      // Collect entries: custom entries (+ optional customType filter) + structural entries
      // Structural entries (model_change, branch_summary) are always included so the
      // exported parentId tree is fully resolvable and the web inspector can show
      // model switches and branch points.
      const entries = full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
      const isStructural = (e: { type: string }) =>
        e.type === 'model_change' || e.type === 'branch_summary';

      const exportedEntries = entries.filter(
        (e) =>
          isStructural(e) || (e.type === 'custom' && (!filterType || e.customType === filterType))
      );

      if (exportedEntries.length === 0) {
        const scope = full ? 'all-entries' : 'current-branch';
        ctx.ui.notify(`No matching entries found in ${scope}`, 'warning');
        return;
      }

      // Re-chain parentIds so the exported entries form a valid tree.
      // Original parentIds often point to message entries (not in the export).
      // We walk up the full session tree until we find the nearest ancestor
      // that IS in the export, giving us a self-contained tree structure.
      const byId = new Map<string, (typeof entries)[number]>(entries.map((e) => [e.id, e]));
      const exportedIds = new Set(exportedEntries.map((e) => e.id));

      const rechainParentId = (entry: (typeof exportedEntries)[number]): string | null => {
        let current: string | null = entry.parentId;
        while (current) {
          if (exportedIds.has(current)) return current;
          const parent = byId.get(current);
          current = parent?.parentId ?? null;
        }
        return null;
      };

      const rechained = exportedEntries.map((e) => ({
        ...e,
        parentId: rechainParentId(e),
      }));

      // Write to tmp directory
      const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      const dir = join(cacheBase, 'pi-telemetry');
      mkdirSync(dir, { recursive: true });

      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const scopeParts = [full ? 'full' : 'branch', filterType].filter(Boolean);
      const scope = scopeParts.join('-');
      const filename = `pi-telemetry-${scope}-${sessionId.slice(0, 8)}-${timestamp}.jsonl`;
      const filepath = join(dir, filename);

      const content = rechained.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filepath, content);

      const structuralCount = exportedEntries.filter((e) => isStructural(e)).length;
      const customCount = exportedEntries.length - structuralCount;
      const parts: string[] = [];
      if (customCount > 0) parts.push(`${customCount} telemetry`);
      if (structuralCount > 0) parts.push(`${structuralCount} structural`);
      const summary = parts.length > 0 ? parts.join(' + ') : `${exportedEntries.length} entries`;
      try {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${opener} ${JSON.stringify(dir)}`, { stdio: 'ignore' });
      } catch {
        // opener not available — ignore silently
      }

      ctx.ui.notify(`Exported ${summary} → ${filepath}`, 'info');
    },
  });

  // ── Session export command ─────────────────────────────────────────────────

  pi.registerCommand('session-export', {
    description:
      'Export full session JSONL (all entry types, current branch only; --full for all branches)',
    getArgumentCompletions: (argumentPrefix: string) => {
      if ('--full'.startsWith(argumentPrefix)) {
        return [{ value: '--full', label: '--full (all branches, not just current)' }];
      }
      return [];
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const full = args.trim().split(/\s+/).includes('--full');

      const entries = full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();

      if (entries.length === 0) {
        const scope = full ? 'all-entries' : 'current-branch';
        ctx.ui.notify(`No entries found in ${scope}`, 'warning');
        return;
      }

      // Write to tmp directory
      const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      const dir = join(cacheBase, 'pi-sessions');
      mkdirSync(dir, { recursive: true });

      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const scope = full ? 'full' : 'branch';
      const filename = `pi-session-${scope}-${sessionId.slice(0, 8)}-${timestamp}.jsonl`;
      const filepath = join(dir, filename);

      const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filepath, content);

      try {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${opener} ${JSON.stringify(dir)}`, { stdio: 'ignore' });
      } catch {
        // opener not available — ignore silently
      }

      ctx.ui.notify(`Exported ${entries.length} entries → ${filepath}`, 'info');
    },
  });
}

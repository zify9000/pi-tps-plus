# pi-tps-plus

Tokens-per-second, **per-turn tool wall time**, and a **per-loop summary** for [pi](https://github.com/earendil-works/pi-coding-agent).

Fork of [`@monotykamary/pi-tps`](https://github.com/monotykamary/pi-tps) (MIT) — upstream's TPS /
TTFT / stall / cost logic is untouched. See [NOTICE.md](NOTICE.md) for the exact boundary.

```
TPS 42.5 tok/s · TTFT 1.2s · 29.7s · tool 12.4s · in 567 · out 1.2K · stall 4.3s×1 · $3.60/M
LOOP #3 -> 21 turns · 4m 12s / 63 tools · 3m 10s / in 200K · out 50K · 1m 3s / TPS 91.3
        -> 42 bash · 10s / 8 edit · 9.4s / 12 read · 1.9s / 2 grep · 1.8s
        -> aborted @ turn #7 · tool err 1
```

## What it adds over upstream

| | Why it matters |
|---|---|
| `tool Xs` on every turn | Upstream tells you the model was fast; it does not tell you the turn took 40 s because a `bash` call slept. Measured as the **union** of tool intervals, so parallel batches are not double counted |
| One summary row per loop | A "loop" is one user prompt plus every retry / follow-up / steering it triggered, until pi settles. Upstream has no cross-turn view |
| Tool-class breakdown | `42 bash · 10s / 8 edit · 9.4s` — answers "what ate the time", folded to your terminal width |
| Summary drawn in the transcript, not the status line | pi has **one** mutable status line and `showStatus()` replaces it, so a `notify()`-based summary erases the freshest TPS line. Upstream-style extensions hit this |
| `/loopstats` | Reprint the last loop, or the last 12 |

## Requirements

- pi `>= 0.x` — developed and tested against the pi build installed on the author's machine; the
  compatibility surface is listed under [pi coupling](#pi-coupling)
- Node `>= 20`

## Install

```bash
pi install git:github.com/zify9000/pi-tps-plus
```

Try it for one run without touching settings:

```bash
pi -e git:github.com/zify9000/pi-tps-plus -p "hello"
```

Only install **one** TPS extension. If `@monotykamary/pi-tps` is still in
`~/.pi/agent/settings.json` → `packages`, you get two banners per turn.

## Display

### Per-turn banner

One extra field, `tool`, omitted below 50 ms or when the turn had no tools. Everything else is upstream.

### Per-loop summary (`agent_settled`)

| Fragment | Meaning |
|---|---|
| `LOOP #3` | 3rd loop of the session: one user prompt → `agent_settled`. `agent_start` fires per low-level run, so it cannot be used for counting |
| `21 turns` | `turn_start` count, i.e. LLM round trips |
| `4m 12s` | loop wall clock: loop start → `agent_settled`. Excludes the time you spend typing between prompts |
| `63 tools · 3m 10s` | call count + tool wall time as an **interval union**; the whole segment is omitted when the loop had no tools |
| `in 200K` | billed input: `input + cacheRead + cacheWrite`, summed per turn. This is repeated context, not context length |
| `out 50K` | output tokens |
| `1m 3s` | `Σ generationMs` (streaming generation, includes TTFT and stalls) |
| `TPS …` | measurable turns only: `Σ measuredOut ÷ Σ (streamMs − stallMs)`. No TTFT, no tool time, no stall in the denominator, so it equals the per-turn banner TPS aggregated over the loop. Omitted rather than faked when no turn is measurable |

Row 2 — tool classes: `count name · busy time`, sorted by **total busy time** (counts look
non-monotonic on purpose: `8 edit` before `12 read` means edits cost more in total). Classes are
folded to `+N · time` so the row never exceeds the terminal width; the slowest class always survives.

Row 3 — anomalies only, and only when they exist: `aborted @ turn #7`, `tool err N`,
`unclosed N` (calls whose `tool_execution_end` never arrived after an abort or crash). Anomalies are
kept out of the title on purpose — `LOOP #4 (aborted @ turn #7) ->` shoves the arrow 20+ columns
right and buries the signal inside the metrics.

Expanded (same toggle as tool output):

```
 busy 2s · ∥1.5× · ttft 3.1s · overhead 58ms · tps(gen) 36.0 · local:some-model
```

### Where the summary is drawn

`LOOP_DISPLAY_TARGET` decides, because pi keeps exactly one mutable status line:

| Value | Behaviour |
|---|---|
| `'transcript'` (default) | drawn by `registerEntryRenderer('loopstats')`: its own transcript component, displaces nothing, survives resume and replay, collapsible |
| `'notify'` | reuse the status slot — the per-turn TPS line gets replaced |
| `'both'` | component plus status notification |
| `'off'` | persist the entry only; read it with `/loopstats` |

The head of the summary (`LOOP #N` through `turns · wall`) is highlighted with the theme accent:
`LOOP_HEAD_STYLE` = `'accent'` | `'accentBold'` | `'bold'` | `'textContrast'` | `'inverse'` |
`'underline'` | `'bgSelected'` | `'plain'`. `node dev/demo-highlight.mjs` prints every variant in
your real theme before you pick.

## Measurement notes (the parts that bite)

**Tool time is an interval union.** pi executes a batch of tool calls concurrently
(`Promise.all` in the agent loop) unless a tool declares `executionMode: "sequential"`. Summing
per-call durations double counts parallel batches: `sleep 3` + `sleep 5` in one batch measured
`5.01 s` as a union versus `8.0 s` summed, while the turn itself was `8.68 s`. Per-class rows report
**busy** time (sum of that class's calls), so class totals can exceed the union figure — that is the
difference between "wall time spent" and "work done".

**Identity:** `wall = generation + tools + overhead`, verified. `overhead` (provider queueing,
dispatch, compaction, gaps) is stored in the entry, never on screen.

**Loop TPS is deliberately narrower than `out ÷ gen`:** unmeasurable turns (burst delivery, too few
chunks, stall-dominated) are excluded, and a loop needs ≥ 100 ms of active generation to report a
number at all. The pessimistic `tpsGen` variant is persisted, not displayed.

**Nested calls** (e.g. `ctx.executeTool` inside codemode) are counted in `nestedToolCalls` and never
timed, because their intervals are contained in the parent's.

## Commands

- `/loopstats` — reprint the latest loop (summary + breakdown + anomalies)
- `/loopstats --all` — last 12 loops in the active branch
- plus everything upstream provides (`/tps-export`, `/session-export`, …)

## Configuration

Constants at the top of [`extensions/pi-tps-plus.ts`](extensions/pi-tps-plus.ts) (moving them to
`pi.registerFlag()` is planned):

| Constant | Default | Purpose |
|---|---|---|
| `TOOL_DISPLAY_MIN_MS` | 50 | hide the banner's `tool` segment below this |
| `LOOP_DISPLAY_TARGET` | `'transcript'` | display channel for the loop rows |
| `LOOP_HEAD_STYLE` | `'accent'` | emphasis of the summary head |
| `LOOP_HEAD_UNDIM_IN_STATUS` | true | emit SGR 22 so the accent survives pi's dim wrapper |
| `LOOP_TOOL_BREAKDOWN_STYLE` | `'twoline'` | `'off'` = summary row only |
| `LOOP_TOOL_BREAKDOWN_MAX` | 6 | class cap before `+N · time` folding |
| `LOOP_TOOL_BREAKDOWN_FIT_WIDTH` | true | fold classes to terminal width instead of hard-wrapping |
| `LOOP_TOOL_BREAKDOWN_ARROW` | `'->'` | continuation-row arrow; `'→'`, `'↳'`, `''` also work |
| `LOOP_TOOL_BREAKDOWN_FLAGS` | false | append `(max …)` / `(!n)` per class |
| `LOOP_MIN_MEASURABLE_MS` | 200 | per-turn minimum active window counted toward loop TPS |
| `LOOP_TPS_MIN_GEN_MS` | 100 | minimum active generation for a loop to report TPS |
| `LOOP_MAX_PLAUSIBLE_TPS` | 10000 | above this, treat the measurement as an artefact |

## Persisted data

`pi.appendEntry('loopstats', …)` — a custom entry, never sent to the model:
`turns wallMs genMs toolMs toolBusyMs overheadMs toolCalls nestedToolCalls toolErrors
incompleteIntervals ttftMs streamMs stallMs stallCount measuredOutput activeGenMs tps tpsGen
toolStats tokens costUsd models outcome abortedAtTurn startedAt settledAt`.
`toolStats[name] = { count, busyMs, maxMs, errors }`.

## pi coupling

Everything the fork depends on that is not in pi's documented contract:

| Dependency | Status |
|---|---|
| `turn_start`, `turn_end`, `tool_execution_start/end`, `agent_start/end/settled`, `message_*`, `session_tree` | imported as **exported types** from `@earendil-works/pi-coding-agent`; a pi rename now fails a typecheck instead of shipping broken |
| `TurnEndEvent.outcome` (via `BoundaryState`) | public |
| `pi.appendEntry` + `pi.registerEntryRenderer` | public |
| `@earendil-works/pi-tui` `Text` | host-provided alias, injected by pi's loader |
| `showStatus()` replacing the previous status line | implementation detail, discovered by reading pi's source. Default channel avoids it entirely; only `LOOP_DISPLAY_TARGET='notify'`/`'both'` and the SGR 22 trick care |

## Development

```bash
npm i                # typescript + @types/node, for typecheck only
npm run check        # compile + event simulation + arithmetic + display invariants + component render
npm run render       # draw both channels from real session entries in the current directory
npm run render -- 3 --expanded
npm run demo:highlight
npm run typecheck
npm run install:local    # copy into ~/.pi/agent/extensions as a read-only live copy
```

`npm run check` and friends locate the pi installation automatically (follows `pi` on `PATH`,
then common global roots); override with `PI_ROOT=/path/to/@earendil-works/pi-coding-agent`.

The dev scripts live in the repo on purpose: files inside pi's extension directories are loaded as
extensions, so nothing executable may ship next to `extensions/pi-tps-plus.ts` at runtime.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

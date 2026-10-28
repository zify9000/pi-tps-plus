# Notice & lineage

`pi-tps-plus` is a fork of **`@monotykamary/pi-tps` 1.3.11** (MIT, see `LICENSE`), which is
itself originally derived from
[`badlogic/pi-mono` `.pi/extensions/tps.ts`](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts).

Unmodified from upstream (all of it still upstream's design):

- token/sec measurement: stream update clock, TTFT, stall detection, dynamic TPS cap for tool-call
  turns, `$ / M` rate derivation, `neuralwatt:turn-energy` billed-cost reconciliation
- per-turn banner layout, `/tps-export` and `/session-export` commands, telemetry persistence and
  rehydration on resume

Added in this fork (marked with `pi-tps-plus:` comments in `extensions/pi-tps-plus.ts`):

- per-turn tool wall time, measured as the **union** of `[tool_execution_start → tool_execution_end]`
  intervals, because pi executes a tool batch in parallel
- per-loop summary at `agent_settled` (turns / wall / tool classes / tokens / TPS)
- transcript rendering via `registerEntryRenderer('loopstats')` so the summary stops stealing
  pi's single mutable status line from the per-turn TPS banner
- `/loopstats`, arrow-aligned continuation rows, terminal-width folding, head highlight

Both this fork and the upstream package are MIT licensed; `LICENSE` is the upstream text, kept verbatim.

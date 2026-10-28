# Changelog

## 0.1.0

First packaged form of the local fork of `@monotykamary/pi-tps` 1.3.11.

- per-turn banner gains `tool Xs`: union of tool execution intervals (parallel batches are not
  double counted), hidden below 50 ms
- per-loop summary row at `agent_settled`:

  ```
  LOOP #3 -> 21 turns · 4m 12s / 63 tools · 3m 10s / in 200K · out 50K · 1m 3s / TPS 91.3
          -> 42 bash · 10s / 8 edit · 9.4s / 12 read · 1.9s / 2 grep · 1.8s
          -> aborted @ turn #7 · tool err 1
  ```

- loop TPS = measurable turns only: `Σ measuredOut ÷ Σ (streamMs − stallMs)`, with `tpsGen`
  (all-turn denominator) persisted but not displayed
- summary is drawn by a `loopstats` entry renderer instead of `notify()`, so it no longer replaces
  the per-turn TPS line in pi's single status slot; `LOOP_DISPLAY_TARGET` selects the channel
- continuation rows align their arrow with the summary arrow and fold to the terminal width
- head of the summary row (`LOOP #N` → turns → wall) highlighted with the theme accent; in the
  notify channel the accent is preceded by SGR 22 because pi wraps notifications in dim
- structured `loopstats` session entry (no model context) plus `/loopstats` and `/loopstats --all`
- event types imported from `@earendil-works/pi-coding-agent` instead of mirrored by hand
- dev harness: event-sequence simulation, arithmetic checks, display invariants, real component
  rendering (`npm run check`)

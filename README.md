# cc-usage-statusbar

A Claude Code mod that puts your real usage on one slim, colored line above the prompt:

```
5h ━━━━━━┃━━━ 62% ↻1h48m   7d ━━━┃━━━━━━ 31% ↻Thu   $1.82   ctx ━━━━━━ 48%
```

On API pricing with a dollar limit, the same line shows spend instead:

```
org ━━━━━━━━┃━━━━━ $312 / $500 ↻Nov 1   today $18.40   session $4.05   ctx 48%
```

- **Bars** are green, amber from 70% (80% for spend) or when you're ahead of pace, and red from 90% (95% for spend).
- **The ┃ marker** is where you'd be if you spent evenly through the window, so you can tell at a glance whether 62% is fine.
- **`/usagebar`** opens a side pane with:
  - a chart of the current 5-hour window, your burn rate, and when you'd hit 100%
  - spend per day, a forecast for the end of the period, when you'd hit the limit, and money left per day
  - cost per turn
- **Notifications** pop up at 80%, 95% and 100% of any window or limit, once per window.
- **Narrow terminals** (under 100 columns) drop the bars and keep the numbers.

## Where the numbers come from

The mod picks the best source it has:

| You are on | Source | What you see |
| --- | --- | --- |
| A Claude subscription | The 5-hour and 7-day windows Claude Code reports | `5h` and `7d` bars, reset countdowns |
| An Enterprise or Console org with an Admin API key | `GET /v1/organizations/spend_limits/effective` (Enterprise, per member), or `spend_limits` plus `cost_report` (Console org or workspace) | `org $420 / $500`, real figures, refreshed every 5 minutes |
| A Claude gateway that enforces a spend limit | The `spend_limit` window Claude Code reports | `org 62%`, or dollars once you set `org_limit_usd` |
| A personal budget you set | Claude Code's own cost, added up across sessions on this machine | `budget ≈$82 / $200` (`≈` because only this machine counts) |
| None of these | The same local tally | `month ≈$82  today $18.40  session $4.05` |

The Admin API is read first, then the gateway, then your budget. Costs follow your organization's own model pricing when an admin has set it, and list prices otherwise.

## Install

This repository is its own plugin marketplace. In Claude Code:

```
/plugin marketplace add KhaiStimpson/cc-usage-statusbar
/plugin install usage-statusbar@cc-usage-statusbar
```

Or from your shell:

```sh
claude plugin marketplace add KhaiStimpson/cc-usage-statusbar
claude plugin install usage-statusbar@cc-usage-statusbar
```

Run `/plugin configure usage-statusbar@cc-usage-statusbar` to set a budget, your gateway's limit or an Admin API key. Everything is optional.

To get updates, run `/plugin marketplace update cc-usage-statusbar`. The plugin's `version` in `.claude-plugin/plugin.json` decides when an update reaches users, so bump it with every release.

To try a local checkout without installing it, run `claude --plugin-dir ./cc-usage-statusbar`.

## Settings

Change these in `/config` (the Admin API key is entered when the plugin is enabled and kept in secure storage):

| Setting | Default | What it does |
| --- | --- | --- |
| `display` | `band` | `band` draws the colored line above the prompt. `status` uses the plain-text status line instead. `both` shows the two. |
| `budget_usd` | `0` | Your own dollar limit. `0` is off. `/usagebar budget 200` sets it too. |
| `budget_period` | `monthly` | `monthly`, `weekly` (from Monday) or `daily`. |
| `org_limit_usd` | `0` | The dollar amount of your gateway's limit, so the percentage the gateway reports can be shown in dollars. |
| `admin_api_key` | — | An `sk-ant-admin…` key. The `ANTHROPIC_ADMIN_KEY` environment variable works too. |
| `admin_user` | — | Enterprise: your `user_…` ID or email, to read your own effective limit. Leave it empty on a Console org. |
| `admin_workspace_id` | — | Console: a `wrkspc_…` ID, to show that workspace's limit and spend instead of the whole org's. |
| `admin_poll_minutes` | `5` | How often to re-read the Admin API. |

## Commands

- `/usagebar` opens the details pane.
- `/usagebar refresh` re-reads the Admin API now.
- `/usagebar budget <usd>` sets your personal budget (`0` turns it off).
- `/usagebar close` closes the pane.

## Development

The mod has three files the engine loads:

- `.claude-plugin/plugin.json`, beside `.claude-plugin/marketplace.json`, which lists this repository as the marketplace's one plugin
- `hooks/hooks.json`
- `hooks/register.tsx`, which pulls in `hooks/model.ts`, `hooks/ledger.ts` and `hooks/admin.ts`

`types/index.d.ts` declares the values the mod keeps in `$.state`.

```sh
claude plugin validate .   # what the engine would refuse
claude plugin test .       # tests/*.test.ts(x)
tsc -p .                   # after the first load writes .claude-plugin/types
```

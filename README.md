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
| A monthly cap you set (`org_limit_usd`), with no gateway or Admin API | Claude Code's own cost, added up across sessions on this machine | `org ≈$312 / $500` |
| A personal budget you set | Claude Code's own cost, added up across sessions on this machine | `budget ≈$82 / $200` (`≈` because only this machine counts) |
| None of these | The same local tally | `month ≈$82  today $18.40  session $4.05` |

The Admin API is read first, then the gateway, then your budget, then the monthly cap counted on this machine. Costs follow your organization's own model pricing when an admin has set it, and list prices otherwise.

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

To set a budget, your gateway's limit or an Admin API key, see [Settings](#settings). Everything is optional.

To get updates, run `/plugin marketplace update cc-usage-statusbar`. The plugin's `version` in `.claude-plugin/plugin.json` decides when an update reaches users, so bump it with every release.

To try a local checkout without installing it, run `claude --plugin-dir ./cc-usage-statusbar`.

## Settings

Every setting is optional. With none set, you get the subscription windows (or your month's spend on API pricing), session cost and context.

### Where to set them

Pick one of these three:

1. **Inside Claude Code:** run `/plugin configure usage-statusbar@cc-usage-statusbar` and fill in the dialog. After that, every setting except the Admin API key also shows up as a row in `/config`.
2. **When installing, from your shell:** pass `--config` once per setting.

   ```sh
   claude plugin install usage-statusbar@cc-usage-statusbar \
     --config budget_usd=200 --config budget_period=weekly
   ```

3. **By hand:** edit `~/.claude/settings.json` (your user settings; Claude Code ignores this key in a project's `.claude/settings.json`). Settings go under `pluginConfigs`, keyed by `usage-statusbar@cc-usage-statusbar`, inside an `options` object. Merge this into the file's existing top-level object rather than replacing it:

   ```json
   {
     "pluginConfigs": {
       "usage-statusbar@cc-usage-statusbar": {
         "options": {
           "display": "band",
           "budget_usd": 200,
           "budget_period": "monthly"
         }
       }
     }
   }
   ```

   Changes made through `/config` apply right away. If a running session misses a hand edit, restart it.

The Admin API key is the exception: don't put it in `settings.json`. Either enter it in `/plugin configure`, which keeps it in your system's secure credential store, or export it as `ANTHROPIC_ADMIN_KEY` in the shell you start Claude Code from.

### Examples by setup

**Pay-per-token with your own budget.** Shows `budget ≈$82 / $200`, counted from Claude Code's cost on this machine:

```json
"options": { "budget_usd": 200, "budget_period": "monthly" }
```

**Your org has a $500/month cap.** Shows `org $312 / $500`. If a Claude gateway enforces the cap, the figure is the gateway's own; otherwise it's counted from Claude Code's spend on this machine and marked `≈`.

```json
"options": { "org_limit_usd": 500 }
```

**Claude Enterprise, reading your own limit from the Admin API.** Put the key in `/plugin configure` or `ANTHROPIC_ADMIN_KEY`, then:

```json
"options": { "admin_user": "you@company.com" }
```

**Console organization, one workspace's limit.** With the key set the same way:

```json
"options": { "admin_workspace_id": "wrkspc_01AbCdEf", "admin_poll_minutes": 10 }
```

**Plain-text status line instead of the colored row:**

```json
"options": { "display": "status" }
```

### All settings

| Setting | Default | What it does |
| --- | --- | --- |
| `display` | `band` | `band` draws the colored line above the prompt. `status` uses the plain-text status line instead. `both` shows the two. |
| `budget_usd` | `0` | Your own dollar limit. `0` is off. `/usagebar budget 200` sets it too. |
| `budget_period` | `monthly` | `monthly`, `weekly` (from Monday) or `daily`. |
| `org_limit_usd` | `0` | Your org's monthly spend cap in dollars. With a gateway that enforces it, it turns the gateway's percentage into dollars. Without one, it's compared with Claude Code's spend on this machine and shown as `org ≈$312 / $500`. |
| `admin_api_key` | — | An `sk-ant-admin…` key. Set it in `/plugin configure` or as `ANTHROPIC_ADMIN_KEY`, never in `settings.json`. |
| `admin_user` | — | Enterprise: your `user_…` ID or email, to read your own effective limit. Leave it empty on a Console org. |
| `admin_workspace_id` | — | Console: a `wrkspc_…` ID, to show that workspace's limit and spend instead of the whole org's. |
| `admin_poll_minutes` | `5` | How often to re-read the Admin API. |

## Commands

- `/usagebar` opens the details pane.
- `/usagebar status` lists the settings the mod received, what Claude Code reports, and which cap it's showing. Start here when a number looks wrong.
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

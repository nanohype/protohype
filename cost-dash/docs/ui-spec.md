# UI Spec: Cost Dashboard

**Component:** cost-dash frontend  
**Author:** Design Agent  
**Follows:** PRD v1, solopreneur audience — glanceable, not enterprise  

---

## Design Philosophy

Dark theme. Dense but calm. Think "htop meets a trading terminal" — monospace numbers, clean grid, no marketing chrome. The operator glances at it in a terminal tab or second monitor. Every pixel earns its place.

---

## Color System (Tailwind tokens)

```
Background:     #0a0a0a  (zinc-950)
Surface:        #18181b  (zinc-900)
Border:         #27272a  (zinc-800)
Text primary:   #fafafa  (zinc-50)
Text muted:     #71717a  (zinc-500)
Text dim:       #3f3f46  (zinc-700)

Green (ok):     #22c55e  (green-500)
Amber (warn):   #f59e0b  (amber-500)
Red (alert):    #ef4444  (red-500)
Blue (sonnet):  #3b82f6  (blue-500)
Purple (opus):  #a855f7  (purple-500)
Cyan (haiku):   #06b6d4  (cyan-500)
```

---

## Typography

- **Font:** `font-mono` (JetBrains Mono via next/font, fallback: monospace)
- **Numbers:** Always monospace, tabular-nums
- **Headers:** 11px uppercase letter-spacing-widest text-zinc-500
- **Values:** 24px font-bold text-zinc-50

---

## Layout: Single Page, Vertical Scroll

```
+-----------------------------------------------------+
|  HEADER: "cost // dash" + last-refreshed + dot       |
+-----------------------------------------------------+
|  SUMMARY BAR (4 cards, horizontal)                   |
|  [Today $X.XX] [Tokens Xk] [Top Agent] [$/day rate] |
+-----------------------------------------------------+
|  BUDGET ALERT BANNER (conditional, amber/red)        |
+------------------------+----------------------------+
|  COST BY AGENT ROLE    |  COST BY WORKFLOW           |
|  (horizontal bar)      |  (donut / pie)              |
|                        |                             |
+------------------------+----------------------------+
|  TOKEN TIMELINE (full width stacked bar + lines)     |
|  [7d] [30d] toggle                                   |
+-----------------------------------------------------+
|  SESSION LOG TABLE (full width)                      |
|  search input + sort headers                         |
+-----------------------------------------------------+
```

---

## Component Specs

### Header
```
cost // dash                        . live  refreshed 12s ago
```
- Dot pulses green on successful refresh, red on error
- "refreshed Xs ago" counts up from last poll
- No nav, no hamburger — single page

### Summary Cards (4 x stat card)

```
+-----------------+
| TODAY           |
| $4.27           |  <- 24px bold, green if < 50% budget
| 1.2M tokens     |  <- 12px muted
+-----------------+
```

Cards: `TODAY` / `THIS SESSION` / `TOP AGENT` / `BURN RATE`

### Budget Alert Banner
- Hidden when under 80% of daily budget
- Amber: "Warning: 83% of $10 daily budget used — $1.70 remaining"
- Red: "Daily budget exceeded — $10.00 limit reached. $2.40 over."
- Dismissible per session (localStorage flag)

### Cost by Agent Role (Bar Chart)
- Recharts `BarChart`, horizontal bars
- Sorted descending by cost
- Each bar labeled with role name + dollar amount
- Color: single blue fill, opacity varies by rank
- Time filter pills above: `session` / `today` / `week` / `all`

### Cost by Workflow (Donut)
- Recharts `PieChart` with innerRadius
- 8 workflow types max visible, rest collapse to "other"
- Tooltip: workflow name, total cost, session count, avg $/session
- Legend right side, 11px mono

### Token Timeline (Stacked Bar + Line overlay)
- X: dates (7 or 30 days)
- Stacked bars: input (blue-800) / output (blue-500) / cache-read (blue-300)
- Overlay lines: Sonnet cost (blue), Opus cost (purple) — right Y axis in $
- Toggle `7d` / `30d` as pills top-right

### Session Log Table

Columns:
| # | Time | Workflow | Agent | Model | In | Out | Cache | Cost | Dur |
|---|------|----------|-------|-------|----|-----|-------|------|-----|

- `Time`: relative ("2m ago") with abs on hover
- `Model`: colored badge — blue=sonnet, purple=opus, cyan=haiku
- `Cost`: right-aligned, monospace, green/amber/red by threshold
- `Dur`: "1m 45s"
- Search: filters across workflow + agent columns
- Default: last 50, `show more` button

---

## Empty State

When no sessions recorded yet:
```
    (hex)  cost // dash

    No sessions recorded yet.

    The coordinator writes to .perf.json
    each time an agent runs. Run a workflow to
    start tracking costs.

    [ View sample data ]   <- loads seeded fixture
```

---

## Responsive Notes
- Min width: 1280px (desktop only per PRD)
- Two-column layout at >=1280px, single column < 1280px
- No mobile optimization required

---

## Animation / Interaction
- Number transitions: count-up animation on value change (200ms ease)
- Chart redraws: 300ms animated via Recharts `animationDuration`
- Refresh indicator: spinning dot for 500ms on each poll
- No page transitions — single-page, no routing

---

## Component Inventory

```
/components
  Header.tsx          — title, live dot, refresh timer
  SummaryBar.tsx      — stat cards row
  BudgetBanner.tsx    — conditional alert banner
  AgentCostChart.tsx  — horizontal bar chart (Recharts)
  WorkflowDonut.tsx   — donut chart (Recharts)
  TokenTimeline.tsx   — stacked bar + line overlay (Recharts)
  SessionTable.tsx    — sortable/searchable table
  ModelBadge.tsx      — colored badge for model name
  EmptyState.tsx      — zero-data state
  TimeFilter.tsx      — reusable pill filter group
```

---

## Dependencies
- `recharts` — charts
- `date-fns` — relative time formatting
- `next/font` — JetBrains Mono

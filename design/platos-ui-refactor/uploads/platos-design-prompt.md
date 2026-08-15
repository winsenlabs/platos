# Platos — Full Application Design Brief

**For:** Claude Design — mockups for a complete frontend rebuild
**Scope:** the *entire* application. Every screen, every state, every shared component.
**Template:** supplied separately by Tejas — slot it in at *[TEMPLATE]* in §3.
**Constraint:** **clean slate.** No existing screen is preserved, no URL must keep working, no user is migrated. Design what the product should be, not a re-skin.

---

## 1. What Platos is

Platos is a **control plane for AI agents**. An operator configures an agent — prompt, model, tools, memory — connects it to external tool providers, exposes it through chat / Slack / an embedded widget, then watches what it costs and whether it worked.

It is self-hosted. The operator runs it on their own infrastructure with their own model-provider keys.

**Users:** technical operators and developers. Comfortable with JSON, model names, token counts. Usually debugging under time pressure.

**One sentence:** *Platos is where you build an agent, and where you find out why it did what it did.*

## 2. Why it's being redesigned

The app is a fork of trigger.dev's dashboard — a task-execution platform — with agent screens bolted alongside. That inheritance is visible everywhere:

- URLs are four segments deep before reaching anything Platos: `/orgs/$slug/projects/$param/env/$envParam/…`
- Half the nav serves an execution engine that has **never executed anything** — Runs, Queues, Schedules, Deployments, Branches, Concurrency, Regions. All being deleted.
- The vocabulary is wrong throughout.
- Config screens expose controls the runtime doesn't read.
- The screens that matter most are the least designed.

**Look at the current app to learn what data exists. Do not look at it for inspiration.**

## 3. Design direction

*[TEMPLATE — apply the supplied design system: type scale, color, spacing, motion, component library.]*

Principles specific to Platos:

**Density is a feature.** These users are debugging. Whitespace that pushes the next relevant fact below the fold is a cost.

**Every number needs provenance.** Costs, token counts and task counts have all been wrong in production. Show where a number came from and when it was computed.

**Broken things must look broken.** A disconnected entity, an undispatchable tool, an unresolved variable, an inert model route — each has failed silently in production. Failure states get as much attention as success states.

**Both themes designed.** Light and dark first-class, neither derived.

**Responsive.** Wide content (traces, tables, JSON) scrolls in its own container; the page body never scrolls horizontally.

## 4. Vocabulary — use exactly these words

| Word | Means |
|---|---|
| **Agent** | A configured AI worker |
| **Thread** | One ongoing conversation between a person and an agent |
| **Turn** | One completed unit of work — the **billable unit** |
| **Step** | One model call inside a turn |
| **Tool** | A capability an agent can invoke |
| **Entity** | An external provider supplying tools |
| **Skill** | A packaged set of instructions and tools |
| **Memory** | What an agent remembers across threads |
| **Artifact** | Something an agent produced |
| **Organization / Project / Environment** | Tenancy |

**Never:** Run, Task, Deployment, Waitpoint, Queue, Attempt, Worker.

---

# THE SCREENS

Every screen below needs **four states**: default · **empty** · **failure** · **dense**.

---

## A. Auth & onboarding

The first impression, and currently pure trigger.dev.

| Screen | Notes |
|---|---|
| **A1. Login** | Email, GitHub OAuth, Google OAuth. ⚠️ Also carries an operator **passcode backdoor** (a "Sign in with passcode" affordance shown only for one configured email). If it survives, design it so it cannot be mistaken for normal login |
| **A2. Magic-link sent** | Confirmation + resend + expiry |
| **A3. MFA challenge** | TOTP entry, backup-code fallback |
| **A4. Logout / signed out** | |
| **A5. Invite accept** | Arriving from an emailed invite — what org, who invited, what access |
| **A6. Confirm basic details** | Post-signup profile completion |
| **A7. Create organization** | First-run. This is the true empty state of the entire product |
| **A8. Create project** | |
| **A9. Select plan** | If billing survives — see §C |

**Design question:** what is the shortest honest path from "signed up" to "an agent answered my message"? Today it's many screens. Consider whether org/project/environment creation can be collapsed or deferred.

---

## B. Home & navigation shell

| Screen | Notes |
|---|---|
| **B1. App shell** | Sidebar/topbar, scope switcher (org → project → environment), breadcrumbs, user menu, theme toggle |
| **B2. Environment home** | Currently `env.$envParam._index`. **There is effectively no overview screen today.** Design one: what does an operator want on landing — agents needing attention, spend today, recent failures, live threads? |
| **B3. Command palette** | With this many objects, keyboard navigation may be the primary interface for a power operator |
| **B4. Global search** | Across agents, threads, tools, memories |

**Design question:** what is the primary axis — agent-first, or project-first? Is Environment a switcher, a URL segment, or hidden until needed?

---

## C. Organization, members, settings, billing

| Screen | Notes |
|---|---|
| **C1. Organization list** | Multi-org switcher |
| **C2. Organization settings** | Name, slug, deletion |
| **C3. Members & roles** | Invite, change role, remove. Role change must invalidate sessions — reflect that |
| **C4. Pending invites** | Resend, revoke |
| **C5. Environment settings — general** | |
| **C6. Environment settings — integrations** | |
| **C7. Environment settings — MCP tokens** | Token mint, list, revoke. Show once, never again |
| **C8. Limits** | Rate limits, concurrency caps |
| **C9. Billing / subscription** | Plan, usage against plan, payment method |
| **C10. Subscription outcome states** | Success, failed, canceled — five distinct return states exist today |

**Open question for Tejas:** does self-hosted Platos have billing at all? If it's Winsen-hosted-only, these may not belong in the OSS product.

---

## D. Account (personal, not org)

| Screen | Notes |
|---|---|
| **D1. Account profile** | |
| **D2. Security** | Password, MFA enrolment, backup codes, active sessions |
| **D3. Personal access tokens** | Create, list, revoke |
| **D4. Authorization code** | OAuth device-flow confirmation |

---

## E. Agents — the core of the product

| Screen | Notes |
|---|---|
| **E1. Agent list** | Name, model, status, tool health, activity, cost trend. An agent whose entity is disconnected — so it *will* fail on its next tool call — must be visibly alarming here |
| **E2. Create agent** | Minimum: name, model, prompt. Show the consequence of each choice inline |
| **E3. Agent config** | The most-used and most defect-prone screen. Prompt blocks, model, model routes, tool exposure, memory policy, feature flags. Has white-screened twice in production. **Panel-level failure isolation is a requirement** |
| **E4. Context tab** | Prompt variables + **resolution status**. Unresolved variables currently reach the model as literal `{{placeholder}}`. Also flag *volatile* variables that must stay out of the cached prefix |
| **E5. Skills tab** | Installed skills, enable/disable, effective config |
| **E6. Tools tab** | What this agent can call **right now**: injected this turn vs reachable via search vs runtime tools; which entity each came from; **whether that entity is connected** |
| **E7. Versions** | Config version history + **diff**. This is Platos's closest thing to code review for agent behaviour — make it read like a good diff, not a JSON dump |
| **E8. Canary** | Set/promote a canary version |
| **E9. Evals A/B** | Compare versions on criteria |
| **E10. Share** | Public/guest link. Guest tokens carry **no verified identity** — make that visible |
| **E11. Postman / debug mode** | Every assembled prompt block, tool call, entity round-trip laid bare |

### E12. Thread list
Conversations for an agent — who, when, turns, cost, status, unresolved failures.

### E13. Thread detail — **the most important screen in the product**

Where an operator answers *"why did it do that?"* and *"why did that cost so much?"*. Give it the most design investment.

Design for four questions:

1. **What did the agent do?** The reasoning → tool call → result → answer chain, legible without expanding everything.
2. **Why was this turn expensive?** Real numbers from a live turn: **44,518 input tokens — 39,795 cache reads, 4,714 cache writes, 9 at full price.** That story is currently invisible and is the single most useful thing this screen could show. Where did tokens go: system prompt, tool schemas, history, or the user's message?
3. **What failed, and whose fault?** Show the ground truth. In one incident the agent said *"the Notes service returned an internal registration error"* when the logged error was `Entity walle-tools not registered` — a Platos dispatch failure, not the provider's.
4. **Where was history compacted?** Show the boundary and what was collapsed.

**Design question:** how do you show a 60-turn thread without overwhelming the operator or hiding the turn that matters?

### E14. Trace view
Span waterfall for a turn — steps, tool calls, latency, cost per span.

### E15. Chat playground
A real turn against the live agent, streaming, with inspection as the *point*. Consider split view: conversation | live assembly.

---

## F. Entities, MCP & tools

| Screen | Notes |
|---|---|
| **F1. Entity list** | Both kinds: **wire** (provider connects in over WebSocket) and **MCP** (Platos connects out). Live connection state |
| **F2. Entity detail** | Heartbeat, **true current tool count** (a stale count showed 22 when the real number was 9), tool ACLs, linked agents |
| **F3. Create entity** | Wire vs MCP branch |
| **F4. Initial secret** | Shown exactly once |
| **F5. Wire test / discovery refresh** | Real result output |
| **F6. MCP servers list** | `mcps._index` — external MCP servers as entities |
| **F7. MCP server detail** | Connection config, discovered tools, credentials |
| **F8. Tool registry** | Every tool across entities and skills, with health (calls, failures, p95, last status). **Must be the diagnostic surface for "the tool exists but won't run"** — dispatchability as a first-class column. Keep the per-tool Test button |
| **F9. Providers & model routes** | Model providers, BYOK keys, credential tests, the model catalogue with **rate provenance** — Platos maintains verified rates because the public price map lags provider cuts by weeks |

---

## G. Memory & knowledge

Currently near-invisible in the UI despite being a core differentiator.

| Screen | Notes |
|---|---|
| **G1. Memory browser** | `memories._index` — search, filter by tier (working / conversation / profile / knowledge), by agent, by user. View, edit, archive, delete |
| **G2. Knowledge graph** | `memories.graph` — entity/relationship visualisation. **A real design challenge**: make a graph genuinely useful rather than a hairball |
| **G3. Memory detail** | Content, source thread, embedding status, rating, which agents can see it |
| **G4. Clusters** | Agent clusters — **the unit across which memory is shared**. Adding an agent widens what it can recall. Make that consequence explicit and slightly weighty; it has leaked data before |

---

## H. Skills

| Screen | Notes |
|---|---|
| **H1. Skill list** | Installed + available, official vs imported |
| **H2. Install / create skill** | |
| **H3. Skill detail** | Manifest, tools contributed, config, which agents use it |

---

## I. Observability, cost & budgets

**These screens were actively lying** — inflated task counts, pages disagreeing with each other, budgets enforcing against a 10×-understated figure.

| Screen | Notes |
|---|---|
| **I1. Monitoring overview** | |
| **I2. Usage by user** | End-user activity |
| **I3. Cost & billing view** | **Turns** not calls as the headline. Cache read/write/full-price split. Four lanes: inference, embedding, extraction, judge. Per-agent and per-skill attribution. Historical rates that don't retroactively change |
| **I4. Budgets** | Set, enforce, alert. Threshold and current position obvious |
| **I5. Traces list** | |

**Design question:** what is the one number an operator checks daily? Build the page around it.

---

## J. Governance & safety

| Screen | Notes |
|---|---|
| **J1. Approvals queue** | Human-in-the-loop. An agent is **blocked waiting** — urgency should be legible |
| **J2. Approval detail** | What's being requested, by which agent, in what context, approve/reject |
| **J3. Governance overview** | Safety events, policy violations |
| **J4. Audit log** | Tool calls, admin actions, **cross-scope access** (this exists because the scope tuple was found not to be a user boundary) |
| **J5. Eval criteria** | Define criteria |
| **J6. Eval runs & results** | Per-criterion judge results and their cost |

---

## K. Background work & environment config

| Screen | Notes |
|---|---|
| **K1. Scheduled work list** | Platos's own background jobs (being renamed — "task" is the old platform's word) |
| **K2. Job detail & run history** | **Failures must surface** — a known bug pattern is errors swallowed and never shown |
| **K3. Create scheduled job** | |
| **K4. Environment variables** | List, create, edit. Secret vs plain distinction; secrets never re-displayed |

---

## L. Public & embedded surfaces

| Screen | Notes |
|---|---|
| **L1. Embedded widget** | Renders inside a third-party page. Compact, themeable, streaming |
| **L2. Public share / guest chat** | Unauthenticated visitor talking to an agent |
| **L3. Docs reader** | 51 pages, text-only |
| **L4. Connect / channels** | Slack and other channel wiring — two ownership models (hosted OAuth vs operator-owned install) |
| **L5. Token mint** | Session token minting for integrators |

---

## M. Admin (Winsen-internal)

| Screen | Notes |
|---|---|
| **M1. Admin dashboard** | Cross-org operator view |
| **M2. Feature flags** | |

May not belong in the OSS product — flag for Tejas.

---

## N. System & error states

Design these as real screens, not afterthoughts:

**N1.** 404 · **N2.** 500 / unexpected error · **N3.** 403 / no access to this org · **N4.** Session expired · **N5.** Maintenance / degraded · **N6.** Offline / connection lost (matters — chat is streaming) · **N7.** Rate limited

---

# THE PARTS — shared component inventory

Design these once; every screen composes them.

**Navigation:** app shell · sidebar · scope switcher · breadcrumbs · tabs · command palette · user menu

**Data display:** data table (sortable, filterable, paginated, bulk-select) · key-value detail panel · stat tile · sparkline · time-series chart · cost breakdown bar · status badge · health indicator · **diff viewer** · **JSON viewer** (collapsible, copyable) · **log/span waterfall** · code block · markdown renderer · graph/network viz

**Chat:** message bubble (user / agent / system) · **tool-call card** (collapsed + expanded, success + failure) · reasoning block · streaming indicator · token/cost footer · citation · attachment · message rating (thumbs)

**Forms:** text/number/select/multi-select · toggle · **secret input** (masked, reveal-once) · **key-value editor** · **ordered block editor** (prompt blocks — drag to reorder) · JSON/schema editor · model picker · search-with-autocomplete · form validation & error summary

**Feedback:** toast · inline alert (info/warn/error/success) · **empty state** · loading skeleton · progress · **confirmation dialog** (destructive actions: delete entity, erase user data, rotate secret) · slide-over panel · modal

**Identity:** avatar · user chip · agent chip · entity chip with connection status · role badge · environment badge

---

# WHAT TO PRODUCE

For **every** screen in §A–N:

1. Mockup in the supplied design system
2. **Empty state** — a new operator has zero of everything. This is the first impression and is currently an afterthought
3. **Failure state** — disconnected entity, malformed config, failed tool call, missing data, expired session
4. **Dense state** — 40 agents, a 60-turn thread, 200 tools, 10k memories. Where does the layout break?

Plus the full **§ Parts** inventory in both themes.

# OPEN QUESTIONS WORTH EXPLORING

- **Primary navigation axis** — agent-first or project-first? Is Environment a switcher, a segment, or hidden until needed?
- **Onboarding depth** — how few screens between signup and a working agent?
- **Is there a home/overview screen?** There isn't one today
- **Command palette as the power interface?**
- **Thread view vs chat playground** — one component or two?
- **Does the OSS product carry billing and admin at all?**
- **The knowledge graph** — is a node-link view actually the right representation, or is there something better?

---

*Everything here is grounded in the shipped product and its real incident history. Where a screen's problems are described, they are things that actually happened.*

repo: winsenlabs/platos
branch: main

## Last sync
date: 2026-08-14T13:55:00Z
### Updated in this project
- Full UI-refactor mockups (33 screens, §A–N of the design brief) built as .dc.html files
- Platos brand assets copied from webapp/public (platos-icon.svg, logotype)
- Vocabulary and screen inventory grounded in webapp/app/routes (agent-* route family)

## Screen map
| Screen | Repo source |
|---|---|
| 10-agents, 11-agent-new, 12–15 agent tabs | webapp/app/routes/...env.$envParam.agents.* |
| 16-threads, 17-thread, 18-trace | ...agents.$agentId.conversations.*, .trace.$threadId |
| 19-playground, 44-debug | ...agents.$agentId.chat, .postman-templates |
| 20-entities, 21-entity, 22-mcp | ...agent-entities.*, mcps._index |
| 23-tools, 24-providers | ...agent-tools._index, agent-providers._index |
| 25-memory, 26-graph, 27-clusters | ...memories._index, memories.graph, agent-clusters.* |
| 28-skills | ...skills._index, skills.new |
| 29-monitoring, 30-cost, 31-budgets | ...agent-monitoring.*, agent-budgets._index |
| 34-approvals, 35-governance, 36-evals | ...agent-governance._index, agent-evals._index |
| 40-settings | ...settings.mcp-tokens, settings.integrations.mcp |
| 42-connect | ...agent-connect.*, agent-connect.mint-token |
| 41-widget | webapp/app/routes/embed.$agentId.tsx |
| 01-auth, 02-onboarding, 05-orgs, 07-billing, 08-account | trigger-inherited auth/org routes (clean-slate redesign per brief) |

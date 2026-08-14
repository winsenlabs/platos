# Platos domain model

Platos is an independent agent application. Trigger is an external durable-runtime service that Platos may use; Trigger's nouns do not define Platos's domain.

## Canonical nouns

| Concept | Canonical noun | Rationale | Database | REST | MCP | UI |
| --- | --- | --- | --- | --- | --- | --- |
| Configured AI worker | **Agent** | The durable, versioned unit that owns prompts, tools, models, memory policy, and budgets. | `Agent` | `/agents` | `agents_*` | Agent |
| User-to-agent conversation | **Thread** | A durable conversation containing ordered turns. | `Thread` | `/threads` | `threads_*` | Thread |
| One completed user-to-agent unit of work | **Turn** | The billable unit: one accepted input and its completed agent response, regardless of model or tool-call count. | `Turn` | `/turns` | `turns_*` | Turn |
| One model invocation | **Step** | A turn can require multiple model invocations as tools are selected and results are incorporated. | `Step` | `/steps` | `steps_*` | Step |
| One invocation of a capability | **Tool Call** | An execution of one tool within a step, including its request, result, status, and timing. | `ToolCall` | `/tool-calls` | `tool_calls_*` | Tool call |
| External tool provider | **Entity** | A connected system or process that registers callable tools with Platos. | `Entity` | `/entities` | `entities_*` | Entity |
| Callable capability | **Tool** | A typed capability available directly or through the tool router. | `Tool` | `/tools` | `tools_*` | Tool |
| Packaged instructions | **Skill** | A reusable, versionable behavior an agent can enable. | `Skill` | `/skills` | `skills_*` | Skill |
| Persisted knowledge | **Memory** | Knowledge retained beyond the current prompt or turn. | `Memory` | `/memories` | `memories_*` | Memory |
| Generated output | **Artifact** | A durable file or structured output produced by an agent. | `Artifact` | `/artifacts` | `artifacts_*` | Artifact |
| Asynchronous Platos-owned background work | **Job** | A user-visible, trackable unit of background work that is not a Trigger task. | `Job` | `/jobs` | `jobs_*` | Job |
| Tenant and security root | **Organization** | The top-level operator boundary for ownership, membership, policy, and billing. | `Organization` | `/organizations` | `organizations_*` | Organization |
| Organization-owned grouping | **Project** | A stable grouping and access boundary for related agents, entities, and resources. | `Project` | `/projects` | `projects_*` | Project |
| Isolated configuration and execution target | **Environment** | A project-scoped boundary for configuration, credentials, data, and traffic; it is not a code-deployment stage. | `Environment` | `/environments` | `environments_*` | Environment |
| Immutable agent configuration snapshot | **Agent Version** | The unit promoted or rolled out; environments do not replace versioning or canary promotion. | `AgentVersion` | `/agent-versions` | `agent_versions_*` | Agent version |
| Runtime-provided Platos capability | **Runtime Tool** | A normal callable tool supplied by Platos, such as `remember`, `recall`, or `spawn_job`. | `Tool` | `/tools` | tool-specific name | Runtime tool |
| Tool-discovery or dispatch router | **Meta-tool** | Reserved exclusively for `find_tools` and `execute_tools`, which locate or invoke other tools. | `Tool` | `/tools` | `find_tools`, `execute_tools` | Meta-tool |

Names in the Database, REST, MCP, and UI columns are normative. Implementations may add a `Platos` prefix where required to avoid a temporary source-level collision during extraction, but public and final persisted names use the canonical noun.

## Decisions

### Turn, not run

A **Turn** is the completed unit of agent work and the billable unit. A turn can contain many steps and tool calls. Platos never calls a turn a run or a task. Trigger may return a vendor-owned `run` identifier for externally durable execution; that identifier remains at the integration boundary and is not exposed as a Platos domain noun.

### Job for background work

Platos-owned asynchronous background work is a **Job**. The canonical runtime tool is `spawn_job`, the persistence model is `Job`, the REST collection is `/jobs`, the MCP family is `jobs_*`, and the UI label is **Jobs**. `spawn_bgo`, `PlatosTask`, and `platos_tasks_*` are retired rather than retained as public aliases on the clean slate.

A Job describes work requested through Platos. It does not model Trigger's task, run, queue, worker, deployment, attempt, or waitpoint. Those remain private vendor concepts when an external Trigger deployment executes a Job durably.

### Environment is an isolation target, not a promotion ladder

An **Environment** is a project-scoped isolation boundary for credentials, configuration, data, connected entities, traffic, and policy. Names such as `development`, `staging`, and `production` are optional operator conventions, not baked-in lifecycle semantics.

Agent configuration is promoted by **Agent Version** and canary rollout. Environment-to-environment code deployment is not a Platos concept. This keeps explicit isolation where operators need it without inheriting Trigger's deployed-code model.

### Meta-tools are only routers

Only `find_tools` and `execute_tools` are **meta-tools**. `remember`, `recall`, `spawn_job`, artifact generation, and similar Platos-supplied capabilities are **runtime tools**. The API and documentation must not use “meta-tool” as a synonym for “built-in tool.”

## Trigger noun disposition

| Trigger noun | Platos disposition |
| --- | --- |
| **Run** | Does not exist as a Platos concept. A completed agent unit is a **Turn**; an external Trigger run is vendor integration metadata only. |
| **Task** | Does not exist as a Platos concept. Agent work is a **Turn** and asynchronous background work is a **Job**; an external Trigger task is vendor integration metadata only. |
| **Deployment** | Does not exist as a Platos concept. Agent configuration changes produce an **Agent Version**, which can be promoted or rolled out. Deployment of Platos itself is infrastructure, not product-domain data. |
| **Waitpoint** | Does not exist as a Platos concept. Waiting is represented by the state of the owning **Turn** or **Job**; an external Trigger waitpoint remains private vendor metadata. |
| **Queue** | Does not exist as a Platos product concept. Scheduling and queueing are implementation details of the selected runtime. A **Job** has a status, not a user-managed queue. |
| **Attempt** | Does not exist as a top-level Platos concept. Retry count and retry events are metadata on the affected **Step**, **Tool Call**, or **Job**. External Trigger attempts remain vendor metadata. |
| **BackgroundWorker** | Does not exist as a Platos product concept. A runtime process may execute a **Job**, but the worker is deployment infrastructure rather than tenant-owned domain data. |

## Consistency rule

Each concept has one public noun. Schema models use the singular noun, REST collections use its kebab-case plural, MCP tool families use its snake-case plural, and UI labels use the same noun. Integration adapters may use an external provider's vocabulary internally only when crossing that provider boundary.

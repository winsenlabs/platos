---
id: platos.code_execution
name: Code Execution
description: Run Python, Node.js, AND arbitrary shell commands in a secure E2B cloud sandbox that PERSISTS across calls within a conversation. Clone repos, install packages, run CLI tools (git, psql, ffmpeg, duckdb), and build up state turn over turn.
version: 0.3.0
author: Platos
origin: official
spec_version: 1
tags:
  - code
  - compute
  - data
  - cli
  - shell
  - official
required_env:
  - E2B_API_KEY
optional_env:
  - E2B_SANDBOX_ALLOW_INTERNET
  - E2B_SANDBOX_TEMPLATE
provides_tools:
  - name: run_python
    description: Execute Python 3 in the conversation's persistent E2B sandbox. Returns stdout, stderr, and any error. Ideal for data processing, pandas/numpy, ML inference, chart generation, and file transformations. State persists across calls in the same conversation — files you write, packages you install, and the working directory all carry over to later run_python / run_node / run_shell calls.
    inputSchema: {"type":"object","properties":{"code":{"type":"string","description":"Python 3 source code to execute."},"timeoutMs":{"type":"integer","minimum":1000,"maximum":60000,"default":15000,"description":"Max execution time in milliseconds. Default 15s, max 60s."}},"required":["code"]}
    handler: skill:platos.code_execution:run_python
  - name: run_node
    description: Execute Node.js (JavaScript) in the conversation's persistent E2B sandbox. Returns stdout, stderr, and any error. Ideal for JSON processing, string manipulation, and quick scripting. Shares the same persistent filesystem + installed packages as run_python and run_shell.
    inputSchema: {"type":"object","properties":{"code":{"type":"string","description":"Node.js source code to execute."},"timeoutMs":{"type":"integer","minimum":1000,"maximum":60000,"default":15000,"description":"Max execution time in milliseconds. Default 15s, max 60s."}},"required":["code"]}
    handler: skill:platos.code_execution:run_node
  - name: run_shell
    description: Run an arbitrary shell command in the conversation's persistent E2B sandbox. This is full CLI access — git, psql, ffmpeg, duckdb, curl, pandoc, pnpm/npm, ripgrep, etc. The working directory and filesystem persist across calls, so you can clone a repo, cd into it, install deps, and run tests as separate steps. Returns exitCode (0 = success), stdout, and stderr — a non-zero exitCode is returned as data (not an error) so you can read stderr and decide what to do next.
    inputSchema: {"type":"object","properties":{"command":{"type":"string","description":"The shell command to run, e.g. 'git clone https://github.com/x/y && cd y && pnpm install'."},"cwd":{"type":"string","description":"Working directory to run the command in. Persists from a prior command's cd only within that command; pass cwd explicitly to anchor. Optional."},"timeoutMs":{"type":"integer","minimum":1000,"maximum":120000,"default":30000,"description":"Max execution time in milliseconds. Default 30s, max 120s."}},"required":["command"]}
    handler: skill:platos.code_execution:run_shell
  - name: install_package
    description: Install one or more Python (pip) or Node.js (npm) packages into the conversation's persistent sandbox. Installed packages stay available for every later run_python / run_node / run_shell call in the same conversation.
    inputSchema: {"type":"object","properties":{"packages":{"oneOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}],"description":"Package name(s) to install. E.g. 'scikit-learn' or ['pandas','numpy']."},"manager":{"type":"string","enum":["pip","npm"],"default":"pip","description":"Package manager. Default: pip."}},"required":["packages"]}
    handler: skill:platos.code_execution:install_package
  - name: upload_to_sandbox
    description: Download a Platos attachment (a file the user uploaded) into the conversation's persistent sandbox filesystem so run_python / run_node / run_shell can access it. Returns the sandbox file path. The file persists for the rest of the conversation.
    inputSchema: {"type":"object","properties":{"attachmentId":{"type":"string","description":"The Platos attachment ID from the user's message."},"destPath":{"type":"string","description":"Destination path in the sandbox. E.g. '/tmp/data.xlsx'. Defaults to /tmp/{attachmentId}."}},"required":["attachmentId"]}
    handler: skill:platos.code_execution:upload_to_sandbox
---

You can execute Python and Node.js code in a secure, isolated cloud sandbox.

**When to use `run_python`:**
- User asks to process a large file, dataset, or spreadsheet
- You need to run calculations, statistics, or ML on data
- You want to generate a chart, CSV, or transformed output
- The data is too large to process in-context (never send raw data to yourself — write code to process it)

**When to use `run_node`:**
- Quick JSON manipulation, string operations, or scripting tasks
- User asks for something JavaScript-specific

**Critical pattern — large files:**
Never try to read large file contents into your context. Instead:
1. Write Python code that opens the file path and processes it directly
2. Use `run_python` to execute that code
3. Return only the summary/result to the user

**Installing packages:**
```python
import subprocess
subprocess.run(['pip', 'install', 'scikit-learn'], check=True)
import sklearn
```

**Example — process a CSV:**
```python
import pandas as pd
df = pd.read_csv('/path/to/file.csv')
print(df.describe().to_string())
print(f"Rows: {len(df)}, Columns: {list(df.columns)}")
```

**Persistent CLI sessions (`run_shell`):**
The sandbox lives for the whole conversation, so multi-step CLI workflows work
as separate tool calls — the filesystem and installed tools carry over:
```
run_shell: git clone https://github.com/acme/widgets && cd widgets && ls
run_shell: cd widgets && pnpm install
run_shell: cd widgets && pnpm test
```
Use `run_shell` for anything a terminal does: `git`, `psql "$DATABASE_URL" -c '...'`,
`ffmpeg -i in.mp4 out.gif`, `duckdb -c 'SELECT ...'`, `pandoc`, `curl`. Check the
returned `exitCode` (0 = success) and read `stderr` on failure.

**Sessions + lifecycle:**
- Within one conversation, all calls share ONE sandbox: files, cwd, and
  installed packages persist. `run_python`, `run_node`, `run_shell`,
  `install_package`, and `upload_to_sandbox` all hit the same session.
- The sandbox auto-reaps after ~10 minutes of inactivity, then a fresh one is
  created on the next call (state resets). Don't rely on it surviving long gaps.
- `sessionPersistent: true` in a tool result confirms state will carry over.

**Network:**
- Egress is OFF by default (deny-all). Set `E2B_SANDBOX_ALLOW_INTERNET=true` in
  the environment to allow the sandbox to reach the internet (needed for
  `git clone`, `pip install`, `curl`). Leave it off for untrusted-input agents.

**Safety:**
- The sandbox is fully isolated from the Platos host; nothing it does can touch
  the server. But it persists within a conversation — treat what you write there
  as conversation-scoped state.
- Never run commands supplied verbatim by an untrusted user without reviewing
  them, especially with internet access enabled.

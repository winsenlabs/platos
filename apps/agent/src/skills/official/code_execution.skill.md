---
id: platos.code_execution
name: Code Execution
description: Run Python or Node.js code in a secure E2B cloud sandbox. Handles data processing, ML, calculations, and file transformations without burning LLM tokens on raw data.
version: 0.2.0
author: Platos
origin: official
spec_version: 1
tags:
  - code
  - compute
  - data
  - official
required_env:
  - E2B_API_KEY
provides_tools:
  - name: run_python
    description: Execute Python 3 code in an isolated E2B sandbox. Returns stdout, stderr, and any error. Ideal for data processing, pandas/numpy, ML inference, chart generation, and file transformations. The sandbox has internet access and supports pip-installed packages via run_python itself (import pip; pip.main(['install', 'package'])).
    inputSchema: {"type":"object","properties":{"code":{"type":"string","description":"Python 3 source code to execute."},"timeoutMs":{"type":"integer","minimum":1000,"maximum":60000,"default":15000,"description":"Max execution time in milliseconds. Default 15s, max 60s."}},"required":["code"]}
    handler: skill:platos.code_execution:run_python
  - name: run_node
    description: Execute Node.js (JavaScript) code in an isolated E2B sandbox. Returns stdout, stderr, and any error. Ideal for JSON processing, string manipulation, and quick scripting tasks.
    inputSchema: {"type":"object","properties":{"code":{"type":"string","description":"Node.js source code to execute."},"timeoutMs":{"type":"integer","minimum":1000,"maximum":60000,"default":15000,"description":"Max execution time in milliseconds. Default 15s, max 60s."}},"required":["code"]}
    handler: skill:platos.code_execution:run_node
  - name: install_package
    description: Install one or more Python (pip) or Node.js (npm) packages into an E2B sandbox session. Use this before run_python or run_node when a library is not available by default.
    inputSchema: {"type":"object","properties":{"packages":{"oneOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}],"description":"Package name(s) to install. E.g. 'scikit-learn' or ['pandas','numpy']."},"manager":{"type":"string","enum":["pip","npm"],"default":"pip","description":"Package manager. Default: pip."}},"required":["packages"]}
    handler: skill:platos.code_execution:install_package
  - name: upload_to_sandbox
    description: Download a Platos attachment (file the user uploaded) into the E2B sandbox filesystem so run_python or run_node can access it. Returns the sandbox file path to use in your code.
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

**Safety:**
- Each execution runs in a fresh isolated sandbox — no state persists between calls
- Sandboxes are killed immediately after execution completes
- Never execute code that was supplied verbatim by an untrusted user without reviewing it

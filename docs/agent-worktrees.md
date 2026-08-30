# Agent worktrees for V1

This procedure creates an isolated agent worktree without mutating the user's
working tree. The authorized V1 baseline is exactly:

```text
6af87259c7b793202dda43ee8a08da352ec69ef4
```

## Non-negotiable protections

- Treat the user's current worktree as protected. Record its path, `HEAD`, and
  status hash before doing anything.
- Never run `git checkout`, `git reset`, `git clean`, or `git stash` in the
  user's worktree.
- Reject branch-name and filesystem-path collisions before creating anything.
- Do not remove a worktree or delete its branch without separate, explicit
  cleanup authorization.

## Create and verify

Run these commands from the protected user worktree after choosing a unique
agent branch and a new path outside that worktree:

```bash
set -eu

BASELINE=6af87259c7b793202dda43ee8a08da352ec69ef4
USER_WORKTREE=$(git rev-parse --show-toplevel)
USER_HEAD=$(git rev-parse HEAD)
USER_STATUS_HASH=$(git status --porcelain=v1 -z | sha256sum | awk '{print $1}')
AGENT_BRANCH=agent/<issue>-<purpose>
AGENT_WORKTREE=/code/winsenlabs/platos-<issue>-<purpose>

test "$(git rev-parse refs/remotes/origin/v1)" = "$BASELINE"
! git show-ref --verify --quiet "refs/heads/$AGENT_BRANCH"
test ! -e "$AGENT_WORKTREE"

git worktree add -b "$AGENT_BRANCH" "$AGENT_WORKTREE" "$BASELINE"

test "$(git -C "$AGENT_WORKTREE" rev-parse HEAD)" = "$BASELINE"
test -z "$(git -C "$AGENT_WORKTREE" status --porcelain=v1)"
test "$(git rev-parse --show-toplevel)" = "$USER_WORKTREE"
test "$(git rev-parse HEAD)" = "$USER_HEAD"
test "$(git status --porcelain=v1 -z | sha256sum | awk '{print $1}')" = "$USER_STATUS_HASH"
```

The `origin/v1` equality check is fail-closed. If the remote-tracking ref is
missing or has moved, stop and obtain an explicitly authorized baseline rather
than substituting another commit.

## Install in the linked worktree

Lefthook installation changes the common repository hook configuration shared
by linked worktrees. The only prepare opt-out is therefore explicit and valid
only when the installer verifies a genuine linked worktree:

```bash
cd "$AGENT_WORKTREE"
PLATOS_SKIP_GIT_HOOKS_IN_LINKED_WORKTREE=1 pnpm install --frozen-lockfile
```

Any other value, malformed Git metadata, or use in a normal repository fails
closed. Omitting the variable runs the repository-owned `lefthook install`.

After installation, re-run the clean-state and exact-`HEAD` checks for the agent
worktree and re-check the protected user's path, `HEAD`, and status hash.

## Cleanup

Stop after delivery. Worktree removal and branch deletion are separate mutations
and require explicit cleanup authorization. Do not infer that authorization from
permission to create or use the worktree.

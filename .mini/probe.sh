export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd ~/work/platos-oss
echo "GITBIN=$(command -v git)"
echo "HEAD=$(git rev-parse HEAD)"
echo "STATUS:"
git status --porcelain | head -5
echo "NODE=$(node -v)"
echo "PNPM=$(command -v pnpm) $(pnpm -v 2>/dev/null)"
echo "WORKTREES:"
git worktree list
echo "COLIMA:"
DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock docker info >/dev/null 2>&1 && echo colima-ok || echo colima-unreachable
echo "CONTAINERS:"
DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null
echo "TMPDIRS:"
ls /tmp | grep -i "^pl-" || true

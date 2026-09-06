export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /tmp/pl-t5files
node /tmp/pl-t5files-mutate.mjs 2>&1 | tail -110

# Read-only disk diagnostic

This standalone Node diagnostic reads filesystem statistics only. It does not run the bot, read file contents, delete data, or change workflows. It does not identify the cause of disk exhaustion. No package install is needed. A path on a network filesystem can involve network activity.

Requires Node 18.15+ or 19.6+, tested on Node 20. Run `node disk-diagnostic.js --path /path/on/affected/filesystem` (defaults to the current directory); use `node --test disk-diagnostic.test.js` for offline tests.

JSON byte values are decimal strings. When `frsize` is provided it is used as the block unit; otherwise `bsize` is used and values are marked `estimated: true`, because the two may differ. These are filesystem-level statistics, not directory sizes or quota guarantees. Inodes, quotas, other mounts, and the source of disk usage are not diagnosed. A filesystem call can stall on an unavailable mount.

Errors are sanitized and never contain the supplied path. Path arguments can still be visible to local processes; do not pass secrets. Exit codes: 0 success/help, 1 filesystem or API error, 2 bad arguments.

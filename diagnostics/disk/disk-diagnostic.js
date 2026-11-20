'use strict';

// Read filesystem capacity only. BigInt avoids silently rounding byte counts.
const fs = require('node:fs');

const usage = 'Usage: node disk-diagnostic.js [--path PATH]';
const messages = {
  ENOENT: 'The selected path does not exist.',
  ENOTDIR: 'A component of the selected path is not a directory.',
  EACCES: 'Permission denied while accessing the selected path.',
  EPERM: 'Operation not permitted for the selected path.',
  ENOSYS: 'Filesystem statistics are not supported on this platform.',
  ENOTSUP: 'Filesystem statistics are not supported for the selected path.',
  EIO: 'An input/output error occurred while reading filesystem statistics.'
};

async function run(args, dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const statfs = Object.prototype.hasOwnProperty.call(dependencies, 'statfs')
    ? dependencies.statfs : fs.promises.statfs;

  if (args.length === 1 && args[0] === '--help') {
    stdout.write(usage + '\n');
    return 0;
  }
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--path' && args[1] !== ''))) {
    stderr.write(usage + '\n');
    return 2;
  }
  if (typeof statfs !== 'function') {
    stderr.write('Disk diagnostic failed (UNSUPPORTED): Node.js does not provide fs.promises.statfs.\n');
    return 1;
  }

  try {
    const stats = await statfs(args.length ? args[1] : '.', { bigint: true });
    if (!stats || typeof stats.bsize !== 'bigint' || stats.bsize <= 0n ||
        typeof stats.blocks !== 'bigint' || stats.blocks < 0n ||
        typeof stats.bavail !== 'bigint' || stats.bavail < 0n || stats.bavail > stats.blocks ||
        (stats.frsize !== undefined && (typeof stats.frsize !== 'bigint' || stats.frsize <= 0n))) {
      stderr.write('Disk diagnostic failed (INVALID_STATS): Filesystem statistics were invalid.\n');
      return 1;
    }
    const unit = stats.frsize === undefined ? stats.bsize : stats.frsize;
    const result = {
      estimated: stats.frsize === undefined,
      unit: stats.frsize === undefined ? 'bsize' : 'frsize',
      total_bytes: (unit * stats.blocks).toString(),
      available_bytes: (unit * stats.bavail).toString()
    };
    stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    // Do not print error.message or path: either may contain sensitive data.
    const rawCode = error && error.code;
    const code = typeof rawCode === 'string' && Object.hasOwn(messages, rawCode)
      ? rawCode : 'UNKNOWN';
    stderr.write(`Disk diagnostic failed (${code}): ${messages[code] || 'Unable to read filesystem statistics.'}\n`);
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = { run };

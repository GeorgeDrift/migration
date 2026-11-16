const actions = new Set(['status', 'apply']);
const databases = new Set(['dev', 'target']);

export function parseArgs(args) {
  const [action, database, ...options] = args;
  if (!actions.has(action) || !databases.has(database) || (action === 'apply' && database !== 'target')) {
    throw new Error('Usage: node run.mjs <status dev|status target|apply target> [--count N] [--allow-dirty] [--allow-destructive] [--resume-partial] [--execute --confirm-target NAME --confirm-host HOST]');
  }

  let count = '1';
  let countSpecified = false;
  let allowDirty = false;
  let allowDestructive = false;
  let resumePartial = false;
  let execute = false;
  let confirmTarget;
  let confirmHost;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (option === '--count' && !countSpecified && i + 1 < options.length) {
      count = options[++i];
      countSpecified = true;
    } else if (option === '--allow-dirty' && !allowDirty) {
      allowDirty = true;
    } else if (option === '--allow-destructive' && !allowDestructive) {
      allowDestructive = true;
    } else if (option === '--resume-partial' && !resumePartial) {
      resumePartial = true;
    } else if (option === '--execute' && !execute) {
      execute = true;
    } else if (option === '--confirm-target' && !confirmTarget && i + 1 < options.length) {
      confirmTarget = options[++i];
    } else if (option === '--confirm-host' && !confirmHost && i + 1 < options.length) {
      confirmHost = options[++i];
    } else {
      throw new Error(`Unknown or repeated option: ${option}`);
    }
  }

  if (action === 'status' && (countSpecified || allowDirty || allowDestructive || resumePartial
      || execute || confirmTarget || confirmHost)) {
    throw new Error('status is read-only and accepts no apply options.');
  }
  if (!/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count))) {
    throw new Error('--count must be a positive integer.');
  }
  if ((confirmTarget || confirmHost) && !execute) {
    throw new Error('--confirm-target and --confirm-host require --execute.');
  }
  if (execute && (!confirmTarget || !confirmHost)) {
    throw new Error('Writing requires --confirm-target NAME and --confirm-host HOST.');
  }
  return {
    action, database, count, allowDirty, allowDestructive, resumePartial,
    execute, confirmTarget, confirmHost,
  };
}

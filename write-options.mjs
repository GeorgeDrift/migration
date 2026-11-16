export function parseWriteOptions(args, usage) {
  let execute = false;
  let strictPreview = false;
  let confirmTarget;
  let confirmHost;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--execute' && !execute) {
      execute = true;
    } else if (option === '--strict-preview' && !strictPreview) {
      strictPreview = true;
    } else if (option === '--confirm-target' && confirmTarget === undefined
        && index + 1 < args.length) {
      confirmTarget = args[++index];
    } else if (option === '--confirm-host' && confirmHost === undefined
        && index + 1 < args.length) {
      confirmHost = args[++index];
    } else {
      throw new Error(`${usage}\nUnknown or repeated option: ${option}`);
    }
  }
  if (!execute && (confirmTarget || confirmHost)) {
    throw new Error('--confirm-target and --confirm-host require --execute.');
  }
  if (execute && (!confirmTarget || !confirmHost)) {
    throw new Error('Writing requires --confirm-target NAME and --confirm-host HOST.');
  }
  if (execute && strictPreview) throw new Error('--strict-preview is read-only and cannot be combined with --execute.');
  return { execute, strictPreview, confirmTarget, confirmHost };
}

export function assertConfirmedTarget(options, target) {
  if (!options.execute) return;
  if (options.confirmTarget !== target.schema || options.confirmHost !== target.host) {
    throw new Error(`To write, confirm target ${target.schema} and host ${target.host}.`);
  }
}

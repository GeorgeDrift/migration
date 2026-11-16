export function parseExperimentArgs(args) {
  const experimentIds = [];
  const loginCodes = [];
  let allExperiments = false;
  let execute = false;
  let confirmTarget;
  let confirmHost;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--experiment-id' && index + 1 < args.length) {
      experimentIds.push(args[++index]);
    } else if (option === '--login-code' && index + 1 < args.length) {
      loginCodes.push(args[++index]);
    } else if (option === '--all-experiments' && !allExperiments) {
      allExperiments = true;
    } else if (option === '--execute' && !execute) {
      execute = true;
    } else if (option === '--confirm-target' && confirmTarget === undefined && index + 1 < args.length) {
      confirmTarget = args[++index];
    } else if (option === '--confirm-host' && confirmHost === undefined && index + 1 < args.length) {
      confirmHost = args[++index];
    } else {
      throw new Error(`Unknown or repeated option: ${option}`);
    }
  }
  if (allExperiments && (experimentIds.length || loginCodes.length)) {
    throw new Error('Choose --all-experiments or selected IDs/login codes, not both.');
  }
  if (!allExperiments && !experimentIds.length && !loginCodes.length) {
    throw new Error('Select --experiment-id, --login-code, or --all-experiments.');
  }
  for (const id of experimentIds) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error('--experiment-id must be a positive integer.');
    }
  }
  if (loginCodes.some(code => !code.trim())) {
    throw new Error('--login-code cannot be empty.');
  }
  if (!execute && (confirmTarget || confirmHost)) {
    throw new Error('--confirm-target and --confirm-host require --execute.');
  }
  if (execute && (!confirmTarget || !confirmHost)) {
    throw new Error('Writing requires --confirm-target NAME and --confirm-host HOST.');
  }
  return { experimentIds: [...new Set(experimentIds.map(Number))],
    loginCodes: [...new Set(loginCodes)], allExperiments,
    execute, confirmTarget, confirmHost };
}

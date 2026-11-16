const choices = new Set([
  'schema', 'all-data', 'stored-procedures', 'one-experiment',
  'one-experiment-with-procedures', 'all', 'experiment-only', 'procedures-only', 'records-only',
]);
const experimentChoices = new Set([
  'one-experiment', 'one-experiment-with-procedures', 'experiment-only',
]);

export function requiresSchemaApply(choice) {
  return choices.has(choice) && !['records-only', 'procedures-only'].includes(choice);
}

export function parseWorkflowArgs(args) {
  const [choice, ...flags] = args;
  if (!choices.has(choice)) {
    throw new Error(`Choose one of: ${[...choices].join(', ')}.`);
  }
  const options = {
    choice, execute: false,
    withProcedures: ['stored-procedures', 'one-experiment-with-procedures', 'all', 'procedures-only'].includes(choice),
    experimentIds: [], loginCodes: [], allExperiments: false,
    confirmTarget: undefined, confirmHost: undefined,
    allowDestructive: false, allowDirty: false, resumePartial: false,
  };
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--execute' && !options.execute) options.execute = true;
    else if (flag === '--with-procedures' && !options.withProcedures
        && ['all-data', 'one-experiment'].includes(choice)) options.withProcedures = true;
    else if (flag === '--allow-destructive' && !options.allowDestructive) options.allowDestructive = true;
    else if (flag === '--allow-dirty' && !options.allowDirty) options.allowDirty = true;
    else if (flag === '--resume-partial' && !options.resumePartial) options.resumePartial = true;
    else if (flag === '--experiment-id' && index + 1 < flags.length) {
      if (choice !== 'experiment-only' && options.experimentIds.length) {
        throw new Error('--experiment-id may be repeated only for experiment-only.');
      }
      options.experimentIds.push(flags[++index]);
    }
    else if (flag === '--login-code' && choice === 'experiment-only'
        && index + 1 < flags.length) options.loginCodes.push(flags[++index]);
    else if (flag === '--all-experiments' && !options.allExperiments
        && choice === 'experiment-only') options.allExperiments = true;
    else if (flag === '--expect-change' && options.expectChange === undefined && index + 1 < flags.length) {
      // Binds execution to the exact schema SQL shown in the preview.
      options.expectChange = flags[++index];
      if (!/^[0-9a-f]{64}$/.test(options.expectChange)) throw new Error('--expect-change must be the SHA-256 shown in the preview.');
    }
    else if (flag === '--confirm-target' && options.confirmTarget === undefined
        && index + 1 < flags.length) options.confirmTarget = flags[++index];
    else if (flag === '--confirm-host' && options.confirmHost === undefined
        && index + 1 < flags.length) options.confirmHost = flags[++index];
    else throw new Error(`Unknown or repeated option: ${flag}`);
  }
  if (experimentChoices.has(choice)) {
    if (options.allExperiments && (options.experimentIds.length || options.loginCodes.length)) {
      throw new Error('Choose --all-experiments or selected IDs/login codes, not both.');
    }
    if (!options.allExperiments) {
      if (!options.experimentIds.length && !options.loginCodes.length) {
        throw new Error('Experiment selection requires a positive --experiment-id or --login-code.');
      }
      for (const id of options.experimentIds) {
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
          throw new Error('--experiment-id must be a positive integer.');
        }
      }
      if (options.loginCodes.some(code => !code.trim())) {
        throw new Error('--login-code cannot be empty.');
      }
      options.experimentIds = [...new Set(options.experimentIds.map(Number))];
    }
  } else if (options.experimentIds.length || options.loginCodes.length) {
    throw new Error('Experiment selectors are only valid for experiment choices.');
  }
  if (!options.execute && options.expectChange) throw new Error('--expect-change requires --execute.');
  if (!options.execute && (options.confirmTarget || options.confirmHost)) {
    throw new Error('Target confirmation requires --execute.');
  }
  if (options.execute && (!options.confirmTarget || !options.confirmHost)) {
    throw new Error('Execution requires --confirm-target NAME and --confirm-host HOST.');
  }
  return options;
}

export function contentStages(options) {
  const stages = [];
  if (['all-data', 'all', 'records-only'].includes(options.choice)) stages.push('all-data');
  if (experimentChoices.has(options.choice)) stages.push('one-experiment');
  if (options.withProcedures) stages.push('stored-procedures');
  return stages;
}

const recordLabels = { 'all-data': 'all records copied', 'one-experiment': 'selected experiment records copied' };

// Plain-language result of an executed run: what this choice migrated and what it left out.
export function migrationSummary(options, report) {
  const stages = contentStages(options);
  const done = new Set(report.completedStages || []);
  const row = (label, inScope, migrated, detail) => `${label.padEnd(17)} | ${
    !inScope ? 'NO  - not part of this choice'
      : migrated ? `YES - ${detail}` : 'NO  - not completed'}`;
  const recordStage = stages.find(stage => recordLabels[stage]);
  let status = 'Finished.';
  if (report.failed) {
    status = `FAILED: ${report.failed}`;
    if (report.rollback?.status === 'verified') status += `\nRolled back to checkpoint ${report.rollback.checkpoint}; nothing from this run remains on the target.`;
    else if (report.rollback) status += `\nROLLBACK FAILED (checkpoint ${report.rollback.checkpoint}): ${report.rollback.error}. Recovery is required.`;
  }
  return [
    `MIGRATION RESULT: ${options.choice} on ${report.target.schema} (${report.target.host})`,
    status,
    row('Schema', requiresSchemaApply(options.choice), done.has('schema-verified'),
      done.has('schema-change') ? `${report.schemaChange.statements} schema statement${report.schemaChange.statements === 1 ? '' : 's'} applied`
        : 'already matched the source; no change needed'),
    row('Records', Boolean(recordStage), done.has(recordStage), recordLabels[recordStage]),
    row('Stored procedures', stages.includes('stored-procedures'), done.has('stored-procedures'),
      'approved procedures copied'),
  ].join('\n');
}

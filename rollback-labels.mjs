export function rollbackLabel(label = '') {
  if (/^Before content stage stored-procedures$|^Before procedures$/i.test(label)) return 'Before stored procedures';
  if (/^Before content stage all-data$|^Before data$/i.test(label)) return 'Before records';
  if (/^Before content stage one-experiment$/i.test(label)) return 'Before experiment records';
  if (/^Before schema change /i.test(label)) return 'Before schema changes';
  return label;
}

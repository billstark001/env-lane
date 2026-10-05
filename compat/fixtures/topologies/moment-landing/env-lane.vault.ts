export default {
  envFiles: ['.env', '.env.production', 'server/.env', 'server/.env.production'],
  outputDir: '.env-lane-vault',
  outputFile: 'store.dat',
  restore: { redaction: 'partial', reveal: { start: 3, end: 2 } },
  disableUnsafeWarning: true,
}

export default {
  selector: {
    envKey: 'ENV_BUILD',
    defaultBuild: 'local',
    forbidInDotenv: true
  },
  workspace: {
    packageGlobs: ['packages/*', 'apps/*'],
    aliases: {},
    includeRoot: true
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env.local',
    requireOverride: false,
    includeProcessEnv: true
  },
  sort: {
    api: {
      file: 'apps/api/.env',
      template: 'apps/api/.env.example',
      unlistedVariablesComment: '',
      files: {
        production: 'apps/api/.env.production'
      }
    }
  },
  vault: {
    enabled: false,
    disableUnsafeWarning: false,
    configFile: 'env-lane.vault.json'
  }
};

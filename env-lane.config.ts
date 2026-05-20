import { defineConfig } from '@env-lane/core';

export default defineConfig({
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
  vault: {
    enabled: false,
    disableUnsafeWarning: false,
    configFile: 'env-lane.vault.json'
  }
});

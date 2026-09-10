// Static legacy config. Evaluation belongs to the Node compatibility tool, not Rust.
export default {
  selector: {
    envKey: 'LANE',
    defaultBuild: 'local',
    builds: ['local', 'development', 'production'],
    buildValidation: 'error',
    forbidInDotenv: true,
  },
  workspace: {
    packageGlobs: ['apps/*', 'packages/*'],
    aliases: {
      backend: '@synthetic/api',
      frontend: '@synthetic/web',
      jobs: 'apps/worker',
      database: '@synthetic/db',
    },
    defaultTarget: '@synthetic/api',
    includeRoot: false,
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env.local',
    includeProcessEnv: false,
  },
}

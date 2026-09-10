// Static legacy config. The equivalent JSON file is the native migration target.
export default {
  selector: {
    envKey: 'LANE',
    defaultBuild: 'local',
    builds: ['local', 'production'],
    buildValidation: 'error',
  },
  workspace: {
    packageGlobs: ['server'],
    aliases: { landing: 'synthetic-landing', api: 'synthetic-landing-server' },
    defaultTarget: 'landing',
    includeRoot: true,
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env',
    includeProcessEnv: false,
  },
}

/**
 * Format-realistic synthetic credentials generated once with local Node/OpenSSL/Foundry tools.
 * They were never provisioned with a provider or funded. Assemble provider-shaped values from
 * fragments so tests receive realistic inputs without storing scan-triggering tokens in Git.
 */
const assemble = (...segments: string[]): string => segments.join('')

const pem = (label: string, ...bodySegments: string[]): string =>
  `-----BEGIN ${label}-----\n${assemble(...bodySegments)}\n-----END ${label}-----`

const UPSTASH_REST_TOKEN = assemble('f1b0d3a3', 'a6278cb8', '06559cd8', '3885c79b')

export const SYNTHETIC_CREDENTIALS = {
  openai: {
    projectKey: assemble(
      'sk',
      '-proj-',
      'RaUrdKOqDneU2Qb_',
      'eOLQ91Z3lgnS0daL',
      'n9jwD8xtjWhGewmrwWpc0CVb769lGg5J',
    ),
    serviceAccountKey: assemble(
      'sk',
      '-svcacct-',
      'tyIrRcb-naOPUisR',
      'mtp70e4eO0IirSbo',
      'DNVsp3b_poALGzWZElkXYOP8dBzWZbgj',
    ),
  },
  supabase: {
    url: 'https://synthetic-test-project.supabase.co',
    publishableKey: assemble(
      'sb',
      '_publishable_',
      'ASeQdqGUd9p0oPso',
      'zlqmXNWJ2BaSpuQj_pdHDGQeQ',
    ),
    secretKey: assemble('sb', '_secret_', 'GgOtfxf3TPY8pCDF', 'yvZICZHKT5qFgfMh_vQa8lCzi'),
    anonJwt: assemble(
      'eyJhbGciOiJIUzI1NiIs',
      'InR5cCI6IkpXVCJ9',
      '.',
      'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bnRoZXRpYy10ZXN0LXByb2plY3QiLCJyb2xlIjoiYW5vbiIs',
      'ImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDE1MzYwMDAwfQ',
      '.',
      '3j5fU2fRcoKelwz82ng-',
      'o1hI4XGqr-jrq-hgYk13mMw',
    ),
    serviceRoleJwt: assemble(
      'eyJhbGciOiJIUzI1NiIs',
      'InR5cCI6IkpXVCJ9',
      '.',
      'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bnRoZXRpYy10ZXN0LXByb2plY3QiLCJyb2xlIjoic2VydmljZV9yb2xlIiw',
      'iaWF0IjoxNzAwMDAwMDAwLCJleHAiOjIwMTUzNjAwMDB9',
      '.',
      '-oW22ShVKBcyyU6nYXIg',
      '19Jg2R3La-w_SNMOGp7x3d0',
    ),
  },
  upstash: {
    restUrl: 'https://synthetic-marmot-12345.upstash.io',
    restToken: UPSTASH_REST_TOKEN,
    aclRestToken: assemble('AYNgASu2NlGX', 'vZH0Cj5MPCLS', 'vLA_P66gHxcLc5DQ='),
    redisUrl: `rediss://default:${UPSTASH_REST_TOKEN}@synthetic-marmot-12345.upstash.io:6379`,
  },
  ethereum: {
    address: '0x6116059AFBf2837ef1FBf7Ed118616bE83aebe2b',
    privateKey: assemble(
      '0x',
      'a176379ffc8d02b8',
      'b356f6612ff443d6',
      'a6f40050dcea4207',
      '17820c5ad88139d5',
    ),
    mnemonic: [
      'choice',
      'suggest',
      'step',
      'legend',
      'labor',
      'panda',
      'nominee',
      'bottom',
      'violin',
      'snake',
      'enact',
      'little',
    ].join(' '),
  },
  cloudflare: {
    userToken: assemble('cfut', '_xi_', 'IuQLYWPjpdjez05Y', 'vZYPUNvjbBj7zIyvNEhrF_dceHOA'),
  },
  github: {
    personalAccessToken: assemble(
      'github',
      '_pat_',
      'gqgZU9ZnAQnlxL5Q',
      'etI9hGfl3yByjlk6',
      'RjdfnRSaXo8F-JQztBT9iY0vwkp_yiyc',
    ),
  },
  stripe: {
    secretKey: assemble('sk', '_live_', '9af9865fa291085c', 'e95ac74b0e82e85c41a39366ec116b85'),
  },
  anthropic: {
    apiKey: assemble(
      'sk',
      '-ant-',
      '5mcxAXMpquus48jy',
      'snPGdQ4L4ndtsRL_',
      'gk6K5J7lrSQfIHAUrblxYhMvji5j2Q6M',
    ),
  },
  paseto: {
    local: assemble(
      'v4',
      '.local.',
      'B6sKORJMlQ-2J9HnT9R5oJlva7MR0itc5cUYLVkRHXnWMNJ4',
      'HWurd8ykOtnhEs7oD2xKOZ2-gEbfUdU4mw5jwA',
    ),
    public: assemble(
      'v4',
      '.public.',
      '8b9W2bQJ70Q8egU4fiWPA3eUFuIUpTEGQlHoMF31UepZaTcMmf0MRu',
      'wvif4cHd_ntAPr9OLF6fCGpqKQwO8VJvx53FFql6nSGpT5NFMR5G3ov8-ICH2kJIk5tOmBhSL0',
    ),
  },
  privy: {
    oauthProviders: 'google,discord,twitter,instagram,tiktok,line,telegram',
  },
  ed25519: {
    publicKey: pem(
      'PUBLIC KEY',
      'MCowBQYDK2VwAyEA3zrPBHQrxvOQn16e',
      'lrFrIfwNn4YHe7L9bUXcr9sit4s=',
    ),
    privateKey: pem(
      'PRIVATE KEY',
      'MC4CAQAwBQYDK2VwBCIEINWyaUdp+z8T',
      'XdlM1HtLChIXO6hIVfAoYvsFr5oSDkNP',
    ),
  },
  generic: {
    opaqueHighEntropy: assemble('Fv5D9_4ioQqw6Cb', '64u7MqzYe0zdFVA', 'u9h7GVx5gWm9I'),
  },
} as const

export const SYNTHETIC_SECRET_CASES = [
  {
    name: 'OpenAI project API key',
    key: 'OPENAI_API_KEY',
    value: SYNTHETIC_CREDENTIALS.openai.projectKey,
    detectableByValue: true,
  },
  {
    name: 'OpenAI service-account API key',
    key: 'OPENAI_SERVICE_ACCOUNT_KEY',
    value: SYNTHETIC_CREDENTIALS.openai.serviceAccountKey,
    detectableByValue: true,
  },
  {
    name: 'Supabase secret key',
    key: 'SUPABASE_SECRET_KEY',
    value: SYNTHETIC_CREDENTIALS.supabase.secretKey,
    detectableByValue: true,
  },
  {
    name: 'Supabase service-role JWT',
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    value: SYNTHETIC_CREDENTIALS.supabase.serviceRoleJwt,
    detectableByValue: true,
  },
  {
    name: 'Supabase anon JWT',
    key: 'SUPABASE_ANON_KEY',
    value: SYNTHETIC_CREDENTIALS.supabase.anonJwt,
    detectableByValue: true,
  },
  {
    name: 'Upstash REST token',
    key: 'UPSTASH_REDIS_REST_TOKEN',
    value: SYNTHETIC_CREDENTIALS.upstash.restToken,
    detectableByValue: false,
  },
  {
    name: 'Upstash REST query token',
    key: 'REQUEST_URL',
    value: `${SYNTHETIC_CREDENTIALS.upstash.restUrl}/get/key?_token=${SYNTHETIC_CREDENTIALS.upstash.restToken}`,
    detectableByValue: true,
  },
  {
    name: 'Upstash ACL REST token',
    key: 'UPSTASH_REDIS_REST_TOKEN',
    value: SYNTHETIC_CREDENTIALS.upstash.aclRestToken,
    detectableByValue: true,
  },
  {
    name: 'Upstash Redis URL',
    key: 'UPSTASH_REDIS_URL',
    value: SYNTHETIC_CREDENTIALS.upstash.redisUrl,
    detectableByValue: true,
  },
  {
    name: 'Ethereum private key',
    key: 'ETHEREUM_PRIVATE_KEY',
    value: SYNTHETIC_CREDENTIALS.ethereum.privateKey,
    detectableByValue: false,
  },
  {
    name: 'Ethereum mnemonic',
    key: 'WALLET_MNEMONIC',
    value: SYNTHETIC_CREDENTIALS.ethereum.mnemonic,
    detectableByValue: false,
  },
  {
    name: 'Cloudflare user token',
    key: 'CLOUDFLARE_API_TOKEN',
    value: SYNTHETIC_CREDENTIALS.cloudflare.userToken,
    detectableByValue: true,
  },
  {
    name: 'GitHub personal access token',
    key: 'GITHUB_TOKEN',
    value: SYNTHETIC_CREDENTIALS.github.personalAccessToken,
    detectableByValue: true,
  },
  {
    name: 'Stripe live secret key',
    key: 'STRIPE_SECRET_KEY',
    value: SYNTHETIC_CREDENTIALS.stripe.secretKey,
    detectableByValue: true,
  },
  {
    name: 'Anthropic API key',
    key: 'ANTHROPIC_API_KEY',
    value: SYNTHETIC_CREDENTIALS.anthropic.apiKey,
    detectableByValue: true,
  },
  {
    name: 'PASETO local token',
    key: 'SESSION_TOKEN',
    value: SYNTHETIC_CREDENTIALS.paseto.local,
    detectableByValue: true,
  },
  {
    name: 'PASETO public token',
    key: 'SESSION_TOKEN',
    value: SYNTHETIC_CREDENTIALS.paseto.public,
    detectableByValue: true,
  },
  {
    name: 'Bearer authorization value',
    key: 'REQUEST_HEADER',
    value: `Bearer ${SYNTHETIC_CREDENTIALS.openai.projectKey}`,
    detectableByValue: true,
  },
  {
    name: 'inline client-secret assignment',
    key: 'LOG_LINE',
    value: `config={"client_secret":"${SYNTHETIC_CREDENTIALS.supabase.secretKey}"}`,
    detectableByValue: true,
  },
  {
    name: 'Ed25519 private key',
    key: 'SIGNING_PRIVATE_KEY',
    value: SYNTHETIC_CREDENTIALS.ed25519.privateKey,
    detectableByValue: true,
  },
  {
    name: 'unlabeled high-entropy value',
    key: 'OPAQUE_VALUE',
    value: SYNTHETIC_CREDENTIALS.generic.opaqueHighEntropy,
    detectableByValue: true,
  },
] as const

export const SYNTHETIC_PUBLIC_CASES = [
  {
    name: 'Supabase publishable key',
    key: 'SUPABASE_PUBLISHABLE_KEY',
    value: SYNTHETIC_CREDENTIALS.supabase.publishableKey,
  },
  {
    name: 'Supabase project URL',
    key: 'SUPABASE_URL',
    value: SYNTHETIC_CREDENTIALS.supabase.url,
  },
  {
    name: 'Upstash REST URL',
    key: 'UPSTASH_REDIS_REST_URL',
    value: SYNTHETIC_CREDENTIALS.upstash.restUrl,
  },
  {
    name: 'Ethereum address',
    key: 'ETHEREUM_ADDRESS',
    value: SYNTHETIC_CREDENTIALS.ethereum.address,
  },
  {
    name: 'Ed25519 public key',
    key: 'JWT_PUBLIC_KEY',
    value: SYNTHETIC_CREDENTIALS.ed25519.publicKey,
  },
  {
    name: 'OAuth provider list',
    key: 'PRIVY_OAUTH_PROVIDERS',
    value: SYNTHETIC_CREDENTIALS.privy.oauthProviders,
  },
] as const

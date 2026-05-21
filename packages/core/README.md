# @env-lane/core

Core APIs for `env-lane`: config loading, pnpm workspace package discovery, target resolution, dotenv injection order, final environment resolution, selector checks, command execution, redaction, and env-file sorting.

```bash
pnpm add -D @env-lane/core
```

```ts
import { listEnvFiles, resolveInjectedEnv } from '@env-lane/core';

const files = await listEnvFiles({ target: 'api', build: 'production' });
const env = await resolveInjectedEnv({ target: 'api', build: 'production' });
```

See the full documentation at https://github.com/billstark001/env-lane#readme.

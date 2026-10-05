# Read-only downstream benchmark (0.5.0 branch)

Measured on 2026-10-05 in the working tree, with the frozen 0.4.2 npm CLI and the 0.5.0
`target/debug/env-lane` binary. Each value is the median of nine processes, in milliseconds.
The order was interleaved. All stdout and stderr were discarded; no dotenv values were printed.
All measured commands exited successfully in both versions.

The three real project directories were used for workspace and file discovery. Each command
received an external temporary `{}` JSON config and a minimal process environment. This was
necessary because their actual configs are TS, and evaluating those files would run project
code. No project script, Vault operation, `run`, `print`, `sync`, or write operation was used.
These results measure CLI startup and read-only Core discovery on the real directory trees;
they do not measure the projects' actual TS config compilation or plugin use.

| Project | Operation | 0.4.2 JS | 0.5.0 Rust | Ratio |
| --- | --- | ---: | ---: | ---: |
| moment-project | packages | 179.71 | 19.97 | 9.00× |
| moment-project | files all | 183.78 | 19.78 | 9.29× |
| moment-project | resolve-target . | 182.00 | 19.90 | 9.15× |
| moment-project | check --target . | 545.95 | 240.88 | 2.27× |
| moment-landing | packages | 184.46 | 9.89 | 18.65× |
| moment-landing | files all | 183.71 | 9.63 | 19.08× |
| moment-landing | resolve-target . | 179.92 | 4.70 | 38.28× |
| moment-landing | check --target . | 183.37 | 19.96 | 9.19× |
| labby | packages | 131.75 | 9.89 | 13.32× |
| labby | files all | 184.91 | 9.72 | 19.02× |
| labby | resolve-target . | 131.82 | 9.66 | 13.65× |
| labby | check --target . | 182.90 | 39.79 | 4.60× |

Static source inspection found root Vault registrations enabled in both moment projects and no
Vault registration in labby. It found no uses of removed command aliases or deprecated Core
symbols in the scanned TS/JS source files. This is a shape check, not a guarantee that the
unevaluated project configs will validate under 0.5.0. The synthetic conformance tests cover
native and executable plugin config parsing without using these production projects.

# @env-lane/config-compat

Compile executable env-lane configuration to a versioned cache for the Rust CLI:

~~~bash
env-lane-config compile --kind main --cwd .
env-lane-config compile --kind vault --package-name @env-lane/vault --cwd .
env-lane-config compile --kind example --package-name @acme/env-lane-example --cwd .
~~~

Each non-main kind is an enabled root plugin field. The runner reads the validated plugin
registrations from Rust and compiles executable config files for all enabled plugins. For a
one-off compile, pass `--package-name` with the kind when its config imports its own npm package;
the runner obtains that name from the registration automatically.

Static configurations reuse the cache until a local source dependency changes. For dynamic
configurations, `env-lane-config run <env-lane arguments>` recompiles and starts the native
binary on each call. The standalone Rust binary does not evaluate JavaScript. Keep
`.env-lane-cache/` outside version control.
For `env-lane-config run run <target> <child command>`, flags after the child command are passed
to that command. Use `--` before it when a child option could look like an env-lane option.

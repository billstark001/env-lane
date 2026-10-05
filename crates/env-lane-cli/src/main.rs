//! The executable owns process snapshots, output streams and exit status.
use clap::Parser;
use env_lane_cli::{
    arguments::{Cli, protect_child_arguments},
    commands,
    output::Output,
};
use env_lane_core::{
    config::{self, OutputFormat},
    error::{Error, Result},
    paths::resolve_path,
    resolve::{Context, Environment},
    workspace,
};

fn peer_version_from_node_modules(executable: &std::path::Path) -> Option<String> {
    for ancestor in executable.ancestors() {
        let modules = if ancestor
            .file_name()
            .is_some_and(|name| name == "node_modules")
        {
            ancestor.to_path_buf()
        } else {
            ancestor.join("node_modules")
        };
        let manifest = modules.join("@env-lane/vault/package.json");
        let Ok(bytes) = std::fs::read(manifest) else {
            continue;
        };
        let Ok(document) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        if document.get("name").and_then(serde_json::Value::as_str) == Some("@env-lane/vault")
            && let Some(version) = document.get("version").and_then(serde_json::Value::as_str)
        {
            return Some(version.to_owned());
        }
    }
    None
}

fn verify_installed_vault_peer(cli: &Cli) -> Result<()> {
    if !matches!(
        cli.command,
        env_lane_cli::arguments::Operation::Vault { .. }
    ) {
        return Ok(());
    }
    let executable = std::env::current_exe()
        .map_err(|error| Error::new("VAULT_VERSION_UNSUPPORTED", error.to_string()))?;
    let executable = executable.canonicalize().unwrap_or(executable);
    let metadata = executable.with_file_name("env-lane-install.json");
    let Ok(bytes) = std::fs::read(metadata) else {
        return Ok(()); // Standalone binaries include Vault without an npm peer.
    };
    let document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| Error::new("VAULT_VERSION_UNSUPPORTED", error.to_string()))?;
    let has_node_modules = executable.ancestors().any(|ancestor| {
        ancestor
            .file_name()
            .is_some_and(|name| name == "node_modules")
    });
    let live_version = peer_version_from_node_modules(&executable);
    let version = if has_node_modules {
        live_version.as_deref()
    } else {
        document
            .get("vaultVersion")
            .and_then(serde_json::Value::as_str)
    };
    let Some(version) = version else {
        return Err(Error::new(
            "VAULT_NOT_INSTALLED",
            "Vault commands require the optional @env-lane/vault package. Install it with: pnpm add -D @env-lane/vault",
        ));
    };
    let parts = |version: &str| -> Option<Vec<u64>> {
        version
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect()
    };
    let expected = parts(env!("CARGO_PKG_VERSION"));
    let actual = parts(version);
    if !matches!((expected, actual), (Some(ref expected), Some(ref actual))
        if expected.len() == 3 && actual.len() == 3
            && expected[0] == actual[0] && expected[1] == actual[1]
            && actual[2] >= expected[2])
    {
        return Err(Error::new(
            "VAULT_VERSION_UNSUPPORTED",
            format!(
                "env-lane {} requires @env-lane/vault ^{}. Install matching versions with: pnpm add -D env-lane@^{} @env-lane/vault@^{}",
                env!("CARGO_PKG_VERSION"),
                env!("CARGO_PKG_VERSION"),
                env!("CARGO_PKG_VERSION"),
                env!("CARGO_PKG_VERSION")
            ),
        ));
    }
    Ok(())
}

fn execute(cli: &Cli, output: &mut Output) -> Result<i32> {
    verify_installed_vault_peer(cli)?;
    if let env_lane_cli::arguments::Operation::Vault { operation } = &cli.command {
        return env_lane_cli::plugins::execute_vault(operation, cli, output);
    }
    let current = std::env::current_dir()
        .map_err(|error| Error::new("CWD_READ_FAILED", error.to_string()))?;
    let cwd = cli
        .common
        .cwd
        .as_ref()
        .map_or(current.clone(), |cwd| resolve_path(&current, cwd));
    let loaded = config::load(&cwd, cli.common.config.as_deref())?;
    output.prefix = !cli.common.no_prefix && loaded.config.output.prefix;
    output.format = if matches!(cli.command, env_lane_cli::arguments::Operation::Plugin(_)) {
        output.format.clone()
    } else if cli.common.json {
        OutputFormat::Json
    } else {
        match cli.common.format.as_deref() {
            None => loaded.config.output.format.clone(),
            Some("text") => OutputFormat::Text,
            Some("json") => OutputFormat::Json,
            Some("dotenv") => OutputFormat::Dotenv,
            Some(_) => {
                return Err(Error::new(
                    "INVALID_OUTPUT_FORMAT",
                    "--format must be one of: text, json, dotenv",
                ));
            }
        }
    };
    let packages = if matches!(
        cli.command,
        env_lane_cli::arguments::Operation::SortFile { .. }
            | env_lane_cli::arguments::Operation::Vault { .. }
    ) {
        Vec::new()
    } else {
        workspace::list_packages(&loaded)?
    };
    let environment: Environment = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &environment,
    };
    let mut diagnostics = Vec::new();
    let result = commands::execute(cli, &context, output, &mut diagnostics);
    for event in diagnostics {
        output.diagnostic(&event)?;
    }
    result
}

fn main() {
    let arguments = protect_child_arguments(std::env::args_os().collect());
    let cli = match Cli::try_parse_from(arguments) {
        Ok(cli) => cli,
        Err(error) => {
            if error.kind() == clap::error::ErrorKind::DisplayVersion {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return;
            }
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp
                    | clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
            ) {
                let _ = error.print();
                return;
            }
            let rendered = env_lane_cli::argument_error::render(&error);
            let output = env_lane_cli::bootstrap::output(&std::env::args_os().collect::<Vec<_>>());
            if rendered.message == "error: missing required argument 'command'" {
                eprintln!("{}", rendered.message);
            } else {
                let _ = output.error(&rendered);
            }
            std::process::exit(1);
        }
    };
    // Successful native commands load configuration exactly once in execute().
    // Vault keeps the 0.4.2 error-rendering defaults before its external plugin runs.
    let mut output = if matches!(
        cli.command,
        env_lane_cli::arguments::Operation::Vault { .. }
            | env_lane_cli::arguments::Operation::Plugin(_)
    ) {
        env_lane_cli::bootstrap::output(&std::env::args_os().collect::<Vec<_>>())
    } else {
        Output {
            format: if cli.common.json || cli.common.format.as_deref() == Some("json") {
                OutputFormat::Json
            } else {
                OutputFormat::Text
            },
            prefix: !cli.common.no_prefix,
        }
    };
    let code = match execute(&cli, &mut output) {
        Ok(code) => code,
        Err(error) => {
            let _ = output.error(&error);
            1
        }
    };
    std::process::exit(code);
}

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

fn execute(cli: &Cli, output: &mut Output) -> Result<i32> {
    let current = std::env::current_dir()
        .map_err(|error| Error::new("CWD_READ_FAILED", error.to_string()))?;
    let cwd = cli
        .common
        .cwd
        .as_ref()
        .map_or(current.clone(), |cwd| resolve_path(&current, cwd));
    let loaded = config::load(&cwd, cli.common.config.as_deref())?;
    output.prefix = !cli.common.no_prefix && loaded.config.output.prefix;
    output.format = if cli.common.json {
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
    let mut output = env_lane_cli::bootstrap::output(&arguments);
    let cli = match Cli::try_parse_from(arguments) {
        Ok(cli) => cli,
        Err(error) => {
            if error.kind() == clap::error::ErrorKind::DisplayVersion {
                let _ = output.line(env!("CARGO_PKG_VERSION"));
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
            if rendered.message == "error: missing required argument 'command'" {
                eprintln!("{}", rendered.message);
            } else {
                let _ = output.error(&rendered);
            }
            std::process::exit(1);
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

//! CLI syntax and run's opaque child-argument boundary.
use clap::{Args, Parser, Subcommand};
use std::{ffi::OsString, path::PathBuf};

#[derive(Debug, Parser)]
#[command(
    name = "env-lane",
    version,
    about = "Workspace-aware dotenv injection and development vault tooling.",
    args_override_self = true
)]
pub struct Cli {
    #[command(flatten)]
    pub common: Common,
    #[command(subcommand)]
    pub command: Operation,
}
#[derive(Debug, Default, Args)]
pub struct Common {
    #[arg(short = 'c', long, global = true)]
    /// env-lane config file
    pub config: Option<PathBuf>,
    #[arg(short = 'b', long, global = true)]
    /// build selector value
    pub build: Option<String>,
    #[arg(long, global = true)]
    /// Base directory for config discovery and relative CLI paths.
    pub cwd: Option<PathBuf>,
    #[arg(long, global = true)]
    /// Output format: text, json, or dotenv.
    pub format: Option<String>,
    #[arg(long, global = true)]
    /// Use JSON output (shorthand for --format json).
    pub json: bool,
    #[arg(long, global = true)]
    pub non_interactive: bool,
    #[arg(long, global = true)]
    /// Omit diagnostic scope prefixes.
    pub no_prefix: bool,
}
#[derive(Debug, Subcommand)]
pub enum Operation {
    /// List discovered workspace packages.
    Packages,
    /// Resolve a target alias/name/path to a package.
    ResolveTarget { target: String },
    /// List dotenv files in injection order.
    #[command(alias = "env-files")]
    Files {
        target: Option<String>,
        #[arg(long)]
        require_override: bool,
    },
    /// Print final injected environment for a target.
    #[command(alias = "env-json")]
    Print {
        target: String,
        #[arg(long)]
        show_secrets: bool,
        #[arg(long)]
        include_shell: bool,
        #[arg(long)]
        no_process_env: bool,
    },
    /// Run a command with injected dotenv environment.
    Run {
        target: String,
        #[arg(long)]
        run_cwd: Option<PathBuf>,
        #[arg(long)]
        quiet: bool,
        #[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<OsString>,
    },
    /// Run a configured env policy check or target dotenv selector check.
    Check {
        #[arg(long)]
        policy: Option<String>,
        #[arg(long)]
        target: Option<String>,
        #[arg(long)]
        require_override: bool,
    },
    /// Run a configured env value sync.
    Sync {
        name: String,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        show_secrets: bool,
    },
    /// Sort one env file using a template env file.
    SortFile {
        env_file: PathBuf,
        template_file: PathBuf,
        #[command(flatten)]
        options: SortOptions,
    },
    /// Sort env files using an env-lane config sort section.
    Sort {
        key: Option<String>,
        env_suffix: Option<String>,
        #[command(flatten)]
        options: SortOptions,
    },
}
#[derive(Debug, Args)]
pub struct SortOptions {
    #[arg(long)]
    pub check: bool,
    #[arg(long)]
    pub eol: Option<String>,
    #[arg(long)]
    pub no_preserve_bom: bool,
}

/// The first child word (or explicit `--`) ends env-lane option parsing. Insert
/// that boundary before handing argv to clap so child flags remain byte-for-byte.
pub fn protect_child_arguments(mut argv: Vec<OsString>) -> Vec<OsString> {
    let mut index = 1;
    let mut run = false;
    let mut target = false;
    while index < argv.len() {
        let argument = argv[index].to_string_lossy();
        if argument == "--" {
            break;
        }
        if argument.starts_with('-') {
            let consumes = matches!(
                argument.as_ref(),
                "-b" | "--build" | "-c" | "--config" | "--cwd" | "--format" | "--run-cwd"
            );
            index += if consumes { 2 } else { 1 };
            continue;
        }
        if !run {
            if argument != "run" {
                break;
            }
            run = true;
        } else if !target {
            target = true;
        } else {
            argv.insert(index, "--".into());
            break;
        }
        index += 1;
    }
    argv
}

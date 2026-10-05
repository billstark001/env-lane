//! CLI syntax and run's opaque child-argument boundary.
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
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
#[derive(Debug, Default, Args, Serialize, Deserialize)]
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
    /// Development Vault operations.
    Vault {
        #[command(subcommand)]
        operation: Box<VaultOperation>,
    },
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
    /// Command supplied by an installed native plugin.
    #[command(external_subcommand)]
    Plugin(Vec<OsString>),
}

#[derive(Debug, Clone, Args, Serialize, Deserialize)]
pub struct VaultCommon {
    #[arg(long)]
    pub vault_config: Option<PathBuf>,
    #[arg(long)]
    pub sync_dir: Option<PathBuf>,
    #[arg(long)]
    pub no_auto_remap: bool,
    #[arg(long)]
    pub allow_unmanaged: bool,
    #[arg(long)]
    pub redaction: Option<String>,
    #[arg(long, overrides_with = "no_reveal")]
    pub reveal: Option<String>,
    #[arg(long, overrides_with = "reveal")]
    pub no_reveal: bool,
}

#[derive(Debug, Clone, Args, Serialize, Deserialize)]
pub struct VaultSelection {
    #[arg(long)]
    pub file: Option<String>,
    #[arg(long)]
    pub key: Option<String>,
    #[arg(long)]
    pub include: Option<String>,
    #[arg(long)]
    pub exclude: Option<String>,
    #[arg(long)]
    pub only: Option<String>,
    #[arg(long, overrides_with = "no_approve_deletes")]
    pub approve_deletes: bool,
    #[arg(long, overrides_with = "approve_deletes")]
    pub no_approve_deletes: bool,
    #[arg(long)]
    pub fail_on: Option<String>,
}

#[derive(Debug, Subcommand, Serialize, Deserialize)]
pub enum VaultOperation {
    Encrypt {
        key_file: PathBuf,
        #[command(flatten)]
        common: VaultCommon,
        #[command(flatten)]
        selection: VaultSelection,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        missing_files: Option<String>,
        #[arg(long)]
        conflicts: Option<String>,
    },
    Plan {
        key_file: PathBuf,
        #[command(flatten)]
        common: VaultCommon,
        #[command(flatten)]
        selection: VaultSelection,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    Decrypt {
        key_file: PathBuf,
        #[command(flatten)]
        common: VaultCommon,
        #[command(flatten)]
        selection: VaultSelection,
        #[arg(long)]
        dry_run: bool,
        #[arg(short = 'y', long)]
        yes: bool,
        #[arg(long)]
        conflicts: Option<String>,
        #[arg(long, overrides_with = "no_prompt_loop")]
        prompt_loop: bool,
        #[arg(long, overrides_with = "prompt_loop")]
        no_prompt_loop: bool,
    },
    Apply {
        key_file: PathBuf,
        #[command(flatten)]
        common: VaultCommon,
        #[arg(long)]
        plan: PathBuf,
        #[arg(short = 'y', long)]
        yes: bool,
        #[arg(long)]
        fail_on: Option<String>,
    },
    Sanitize {
        key_file: PathBuf,
        #[arg(long)]
        vault_config: Option<PathBuf>,
        #[arg(long)]
        excluded: bool,
        #[arg(long)]
        dry_run: bool,
        #[arg(short = 'y', long)]
        yes: bool,
    },
    Prune {
        key_file: PathBuf,
        #[arg(long)]
        vault_config: Option<PathBuf>,
        #[arg(long)]
        file: Option<PathBuf>,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        older_than_days: Option<f64>,
        #[arg(long)]
        keep_recent: Option<usize>,
        #[arg(long)]
        no_preserve_latest: bool,
        #[arg(long)]
        dry_run: bool,
        #[arg(short = 'y', long)]
        yes: bool,
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

//! Vault CLI option validation and shared filesystem access.
use env_lane_cli::{
    arguments::{VaultCommon, VaultSelection},
    output::Output,
};
use env_lane_core::{
    error::{Error, Result},
    paths::resolve_path,
    resolve::Context,
};
use env_lane_vault::{
    config::{self, Config, Redaction, Reveal},
    crypto,
    push::ConflictStrategy,
    selection,
    store::{self, ReadOptions, Scope},
};
use std::{
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
};

pub(super) fn invalid(code: &'static str, message: &'static str) -> Error {
    Error::new(code, message)
}
pub(super) fn strategy(raw: Option<&str>) -> Result<ConflictStrategy> {
    match raw.unwrap_or("abort") {
        "abort" => Ok(ConflictStrategy::Abort),
        "keep-local" => Ok(ConflictStrategy::KeepLocal),
        "take-vault" => Ok(ConflictStrategy::TakeVault),
        _ => Err(invalid(
            "VAULT_INVALID_CONFLICT_STRATEGY",
            "--conflicts must be one of: abort, keep-local, take-vault",
        )),
    }
}
pub(super) fn fail_on(raw: Option<&str>) -> Result<Option<&str>> {
    match raw {
        None | Some("change" | "conflict" | "warning") => Ok(raw),
        _ => Err(invalid(
            "VAULT_INVALID_FAIL_ON",
            "--fail-on must be conflict, change, or warning.",
        )),
    }
}
pub(super) fn filter(options: &VaultSelection) -> Result<selection::PreparedFilter> {
    let filter = selection::Filter {
        file: options.file.clone(),
        key: options.key.clone(),
        include: options.include.clone(),
        exclude: options.exclude.clone(),
        only: options.only.clone(),
        approve_deletes: !options.no_approve_deletes,
    };
    filter.compile()
}
pub(super) fn operation_config(
    context: &Context<'_>,
    explicit: Option<&Path>,
    common: Option<&VaultCommon>,
) -> Result<Config> {
    let mut config = config::load(context.loaded, explicit)?;
    if let Some(common) = common {
        if common.no_auto_remap {
            config.auto_remap_paths = false;
        }
        if common.allow_unmanaged {
            config.allow_unmanaged = true;
        }
        if let Some(value) = &common.redaction {
            config.restore.redaction = match value.as_str() {
                "full" => Redaction::Full,
                "partial" => Redaction::Partial,
                "none" => Redaction::None,
                _ => {
                    return Err(invalid(
                        "VAULT_INVALID_REDACTION",
                        "--redaction must be one of: full, partial, none",
                    ));
                }
            };
        }
        if common.no_reveal {
            config.restore.reveal = None;
        }
        if let Some(value) = &common.reveal {
            let (start, end) = value.split_once(':').ok_or_else(|| invalid("VAULT_INVALID_REVEAL", "--reveal must use start:end counts between 0 and 64, for example: --reveal 4:4"))?;
            let (start, end) = (start.parse::<u8>(), end.parse::<u8>());
            config.restore.reveal = match (start, end) {
                (Ok(start), Ok(end)) if start <= 64 && end <= 64 => Some(Reveal { start, end }),
                _ => {
                    return Err(invalid(
                        "VAULT_INVALID_REVEAL",
                        "--reveal must use start:end counts between 0 and 64, for example: --reveal 4:4",
                    ));
                }
            };
        }
    }
    Ok(config)
}
pub(super) fn sync_path(cwd: &Path, common: &VaultCommon) -> Option<PathBuf> {
    common.sync_dir.as_ref().map(|path| resolve_path(cwd, path))
}
pub(super) fn key(cwd: &Path, file: &Path) -> Result<crypto::VaultKey> {
    crypto::load_key(&resolve_path(cwd, file))
}
pub(super) fn warning(config: &Config, output: &Output) -> Result<()> {
    if !config.disable_unsafe_warning && !output.is_json() {
        writeln!(
            io::stderr().lock(),
            "[env-lane] warning VAULT_UNSAFE: Development Vault is not a production secret manager."
        )
        .map_err(|error| Error::new("OUTPUT_FAILED", error.to_string()))?;
    }
    Ok(())
}
pub(super) fn prompt(message: &str, non_interactive: bool) -> Result<bool> {
    if non_interactive || !io::stdin().is_terminal() {
        return Err(invalid(
            "VAULT_CONFIRMATION_REQUIRED",
            "Vault operation requires --yes.",
        ));
    }
    write!(io::stderr().lock(), "{message} [y/N] ")
        .map_err(|error| Error::new("OUTPUT_FAILED", error.to_string()))?;
    io::stderr()
        .flush()
        .map_err(|error| Error::new("OUTPUT_FAILED", error.to_string()))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| Error::new("INPUT_FAILED", error.to_string()))?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes" | "YES"))
}
pub(super) fn read_store(
    config: &Config,
    key: &crypto::VaultKey,
    cwd: &Path,
) -> Result<store::Store> {
    store::read(
        &config.store_path,
        key,
        &Scope {
            base_dir: &config.base_dir,
            invocation_cwd: cwd,
            managed_files: &config.env_files,
            auto_remap_paths: config.auto_remap_paths,
        },
        &ReadOptions::default(),
    )
}

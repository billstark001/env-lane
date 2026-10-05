//! Vault owns its command grammar; the host forwards opaque argv.
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "vault", version)]
pub struct VaultCli {
    #[command(subcommand)]
    pub operation: VaultOperation,
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

#[cfg(test)]
mod tests {
    use super::{VaultCli, VaultOperation};
    use clap::Parser;
    #[test]
    fn vault_positive_and_negative_flags_follow_the_last_occurrence() {
        for (flags, reveal, no_reveal, prompt_loop, no_prompt_loop, no_approve_deletes) in [
            (
                vec![
                    "--reveal",
                    "1:1",
                    "--no-reveal",
                    "--prompt-loop",
                    "--no-prompt-loop",
                    "--approve-deletes",
                    "--no-approve-deletes",
                ],
                None,
                true,
                false,
                true,
                true,
            ),
            (
                vec![
                    "--no-reveal",
                    "--reveal",
                    "1:1",
                    "--no-prompt-loop",
                    "--prompt-loop",
                    "--no-approve-deletes",
                    "--approve-deletes",
                ],
                Some("1:1"),
                false,
                true,
                false,
                false,
            ),
        ] {
            let mut arguments = vec!["vault", "decrypt", "key.txt"];
            arguments.extend(flags);
            let cli = VaultCli::try_parse_from(arguments).unwrap();
            let operation = cli.operation;
            let VaultOperation::Decrypt {
                common,
                selection,
                prompt_loop: parsed_loop,
                no_prompt_loop: parsed_no_loop,
                ..
            } = operation
            else {
                panic!("vault decrypt command")
            };
            assert_eq!(common.reveal.as_deref(), reveal);
            assert_eq!(common.no_reveal, no_reveal);
            assert_eq!(parsed_loop, prompt_loop);
            assert_eq!(parsed_no_loop, no_prompt_loop);
            assert_eq!(selection.no_approve_deletes, no_approve_deletes);
        }
    }

    #[test]
    fn vault_apply_accepts_fail_on_like_the_public_commander_command() {
        let cli = VaultCli::try_parse_from([
            "vault",
            "apply",
            "key.txt",
            "--plan",
            "approval.json",
            "--yes",
            "--fail-on",
            "change",
        ])
        .unwrap();
        let operation = cli.operation;
        let VaultOperation::Apply { fail_on, .. } = operation else {
            panic!("vault apply command")
        };
        assert_eq!(fail_on.as_deref(), Some("change"));
    }
}

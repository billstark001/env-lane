use clap::Parser;
use env_lane_cli::arguments::{Cli, Operation, VaultOperation, protect_child_arguments};
use std::ffi::OsString;

#[test]
fn run_protects_child_arguments_after_both_boundary_forms() {
    for boundary in [vec![], vec!["--"]] {
        let mut arguments = vec![
            "env-lane",
            "-cconfig.json",
            "run",
            "app",
            "--build=local",
            "--quiet",
        ];
        arguments.extend(boundary);
        arguments.extend(["child", "--json", "--help", "--", "space value", ""]);
        let parsed = Cli::try_parse_from(protect_child_arguments(
            arguments.into_iter().map(OsString::from).collect(),
        ))
        .unwrap();
        assert!(!parsed.common.json);
        assert_eq!(parsed.common.build.as_deref(), Some("local"));
        let Operation::Run { command, quiet, .. } = parsed.command else {
            panic!("run operation")
        };
        assert!(quiet);
        assert_eq!(
            command,
            ["child", "--json", "--help", "--", "space value", ""]
        );
    }
}

#[test]
fn missing_command_is_a_parser_error_and_aliases_resolve_to_typed_operations() {
    assert!(Cli::try_parse_from(["env-lane", "run", "app", "--quiet"]).is_err());
    let parsed = Cli::try_parse_from(["env-lane", "env-files", "app", "--json"]).unwrap();
    assert!(parsed.common.json);
    assert!(matches!(parsed.command, Operation::Files { .. }));
}

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
        let mut arguments = vec!["env-lane", "vault", "decrypt", "key.txt"];
        arguments.extend(flags);
        let cli = Cli::try_parse_from(arguments).unwrap();
        let Operation::Vault { operation } = cli.command else {
            panic!("vault command")
        };
        let VaultOperation::Decrypt {
            common,
            selection,
            prompt_loop: parsed_loop,
            no_prompt_loop: parsed_no_loop,
            ..
        } = *operation
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
    let cli = Cli::try_parse_from([
        "env-lane",
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
    let Operation::Vault { operation } = cli.command else {
        panic!("vault command")
    };
    let VaultOperation::Apply { fail_on, .. } = *operation else {
        panic!("vault apply command")
    };
    assert_eq!(fail_on.as_deref(), Some("change"));
}

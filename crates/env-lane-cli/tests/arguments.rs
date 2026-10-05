use clap::Parser;
use env_lane_cli::arguments::{Cli, Operation, is_run_command, protect_child_arguments};
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
fn missing_command_and_removed_alias_are_parser_errors() {
    assert!(Cli::try_parse_from(["env-lane", "run", "app", "--quiet"]).is_err());
    let parsed = Cli::try_parse_from(["env-lane", "env-files", "app", "--json"]).unwrap();
    assert!(matches!(parsed.command, Operation::Plugin(_)));
}

#[test]
fn run_argument_errors_keep_stdout_reserved_for_the_child() {
    for arguments in [
        vec!["env-lane", "--json", "run", "app", "--quiet"],
        vec!["env-lane", "--config", "synthetic.json", "run", "app"],
    ] {
        assert!(is_run_command(
            &arguments
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
        ));
    }
    assert!(!is_run_command(
        &["env-lane", "--config", "run", "packages"]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
    ));
}

use clap::Parser;
use env_lane_cli::arguments::{Cli, Operation, protect_child_arguments};
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

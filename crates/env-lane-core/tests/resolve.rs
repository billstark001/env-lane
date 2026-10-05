use env_lane_core::{
    config::{self, LoadedConfig},
    resolve::{Context, Environment, Options, ValueOrigin},
    workspace::{self, Package},
};
use std::fs;
use tempfile::TempDir;

fn workspace_fixture() -> (TempDir, LoadedConfig, Vec<Package>) {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    fs::write(root.join("package.json"), r#"{"name":"app"}"#).unwrap();
    fs::write(root.join(".env"), "A=base\nB=base-only\n").unwrap();
    fs::write(root.join(".env.local"), "A=override\n").unwrap();
    let loaded = config::load(root, None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    (temporary, loaded, packages)
}

#[test]
fn precedence_and_origins_distinguish_dotenv_process_and_selector() {
    let (_temporary, loaded, packages) = workspace_fixture();
    let process_env = Environment::from([
        ("A".into(), "shell".into()),
        ("C".into(), "shell-only".into()),
        ("ENV_BUILD".into(), "production".into()),
    ]);
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &process_env,
    };
    let resolved = context
        .resolve(
            &Options {
                build: Some("local"),
                ..Default::default()
            },
            &mut Vec::new(),
        )
        .unwrap();
    assert_eq!(resolved.values["A"], "shell");
    assert_eq!(resolved.values["B"], "base-only");
    assert_eq!(resolved.values["ENV_BUILD"], "local");
    assert!(matches!(
        resolved.sources["A"],
        ValueOrigin::Process {
            shell_override: Some(true)
        }
    ));
    assert!(matches!(
        resolved.sources["C"],
        ValueOrigin::Process {
            shell_override: None
        }
    ));
    assert!(matches!(
        resolved.sources["B"],
        ValueOrigin::Dotenv { line: Some(2), .. }
    ));
    assert!(matches!(
        resolved.sources["ENV_BUILD"],
        ValueOrigin::Selector {
            shell_override: true
        }
    ));
}

#[test]
fn repeat_calls_read_changed_files_instead_of_caching_secret_values() {
    let (temporary, loaded, packages) = workspace_fixture();
    let process_env = Environment::new();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &process_env,
    };
    let options = Options {
        include_process_env: Some(false),
        ..Default::default()
    };
    let first = context.resolve(&options, &mut Vec::new()).unwrap();
    fs::write(temporary.path().join(".env.local"), "A=updated\n").unwrap();
    let second = context.resolve(&options, &mut Vec::new()).unwrap();
    assert_eq!(first.values["A"], "override");
    assert_eq!(second.values["A"], "updated");
}

#[test]
fn missing_required_file_fails_before_reading_forbidden_selector() {
    let (temporary, loaded, packages) = workspace_fixture();
    fs::write(temporary.path().join(".env"), "ENV_BUILD=forbidden\n").unwrap();
    let process_env = Environment::new();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &process_env,
    };
    let missing = context
        .resolve(
            &Options {
                build: Some("production"),
                require_override: Some(true),
                ..Default::default()
            },
            &mut Vec::new(),
        )
        .unwrap_err();
    assert_eq!(missing.code, "MISSING_REQUIRED_ENV_FILE");
    let forbidden = context
        .resolve(&Options::default(), &mut Vec::new())
        .unwrap_err();
    assert_eq!(forbidden.code, "SELECTOR_IN_DOTENV");
}

#[test]
fn unlisted_build_is_a_diagnostic_or_error_according_to_policy() {
    let (_temporary, mut loaded, packages) = workspace_fixture();
    loaded.config.selector.builds = vec!["production".into()];
    let process_env = Environment::new();
    let mut diagnostics = Vec::new();
    Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &process_env,
    }
    .resolve(&Options::default(), &mut diagnostics)
    .unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "UNLISTED_BUILD");
    loaded.config.selector.build_validation = config::Validation::Error;
    let error = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &process_env,
    }
    .resolve(&Options::default(), &mut Vec::new())
    .unwrap_err();
    assert_eq!(error.code, "UNLISTED_BUILD");
}

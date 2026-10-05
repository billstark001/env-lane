use env_lane_core::{
    config,
    resolve::{Context, Environment, Options},
    run::{self, WorkingDirectory},
    workspace,
};
use std::{fs, path::Path};

#[test]
fn prepared_execution_separates_paths_arguments_and_resolution() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::create_dir_all(root.join("packages/app")).unwrap();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join("packages/app/package.json"), "{\"name\":\"app\"}").unwrap();
    fs::write(root.join("packages/app/.env"), "VALUE=from-file\n").unwrap();
    let loaded = config::load(root, None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    let process_env = Environment::new();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &process_env,
    };
    let options = Options {
        target: Some("app"),
        ..Default::default()
    };
    let command = ["program", "two words", "--json", "", "日本語"];
    let prepared = run::prepare(
        &context,
        &options,
        &command,
        WorkingDirectory::Target,
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(prepared.cwd, root.join("packages/app"));
    assert_eq!(prepared.environment.values["VALUE"], "from-file");
    assert_eq!(prepared.arguments, command[1..]);
    let prepared = run::prepare(
        &context,
        &options,
        &command,
        WorkingDirectory::Path(Path::new("root")),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(prepared.cwd, root.join("root"));
    let prepared = run::prepare(
        &context,
        &options,
        &command,
        WorkingDirectory::ProjectRoot,
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(prepared.cwd, root);
}

#[test]
fn missing_command_precedes_target_and_file_errors() {
    let temporary = tempfile::tempdir().unwrap();
    let loaded = config::load(temporary.path(), None).unwrap();
    let process_env = Environment::new();
    let context = Context {
        loaded: &loaded,
        packages: &[],
        process_env: &process_env,
    };
    let error = run::prepare(
        &context,
        &Options {
            target: Some("missing"),
            ..Default::default()
        },
        &[] as &[&str],
        WorkingDirectory::Target,
        &mut Vec::new(),
    )
    .unwrap_err();
    assert_eq!(error.code, "MISSING_COMMAND");
}

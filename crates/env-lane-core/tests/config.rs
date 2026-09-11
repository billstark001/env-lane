use env_lane_core::{
    config::{Config, load, parse_yaml},
    paths::find_root,
};
use serde_json::{Value, json};
use std::{fs, path::Path};
use tempfile::TempDir;

#[test]
fn json_and_yaml_share_defaults_and_schema() {
    let yaml = "selector:\n  envKey: LANE\n  builds: [local, production]\nworkspace:\n  includeRoot: false\n";
    let json = json!({"selector":{"envKey":"LANE","builds":["local","production"]},"workspace":{"includeRoot":false}});
    let from_yaml =
        serde_json::to_value(Config::from_value(parse_yaml(yaml).unwrap()).unwrap()).unwrap();
    let from_json = serde_json::to_value(Config::from_value(json).unwrap()).unwrap();
    assert_eq!(from_yaml, from_json);
    assert_eq!(
        from_json["dotenv"]["order"],
        json!([".env", ".env.{build}"])
    );
    assert_eq!(from_json["selector"]["buildValidation"], "warn");
}

#[test]
fn yaml_rejects_non_json_data_including_nested_values() {
    for content in [
        "a: 1\na: 2",
        "a: { b: 1, b: 2 }",
        "1: value",
        "a: { true: value }",
        "a: !custom value",
        "a: [!custom value]",
        "a: 1\n---\na: 2",
        "a: .nan",
        "a: .inf",
        "a: -.inf",
    ] {
        assert!(parse_yaml(content).is_err(), "accepted {content:?}");
    }
    assert_eq!(parse_yaml("value: NO").unwrap()["value"], "NO");
    assert_eq!(parse_yaml("value: null").unwrap()["value"], Value::Null);
}

#[test]
fn known_fields_reject_null_empty_values_and_conflicting_sources() {
    for raw in [
        json!({"sort":null}),
        json!({"selector":null}),
        json!({"sort":{"app":{"file":null}}}),
        json!({"selector":{"envKey":""}}),
        json!({"selector":{"buildValidation":"invalid"}}),
        json!({"workspace":{"defaultTarget":""}}),
        json!({"checks":{"check":{"sources":{"a":{"file":"a","target":"app"}},"rules":[]}}}),
        json!({"checks":{"check":{"sources":{"a":{}},"rules":[]}}}),
        json!({"checks":{"check":{"sources":{},"rules":[{"type":"requiredAny","source":"a","keys":[]}]}}}),
        json!({"sync":{"job":{"from":{"file":"a"},"to":{"file":"b"},"mappings":[]}}}),
    ] {
        assert!(Config::from_value(raw.clone()).is_err(), "accepted {raw}");
    }
    // Extensions are ignored instead of recursively imposing the native schema
    // on data the application does not own.
    assert!(Config::from_value(json!({"extension":null,"selector":{"extension":null}})).is_ok());
}

fn write(root: &Path, path: &str, content: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn explicit_config_keeps_invocation_project_and_config_directories_distinct() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    write(root, "package.json", "{}");
    write(root, "pnpm-workspace.yaml", "packages: [apps/*]");
    write(root, "apps/web/package.json", "{}");
    write(
        root,
        "settings/native.json",
        r#"{"sort":{"web":{"baseDir":"apps/web"}}}"#,
    );
    let cwd = root.join("apps/web");
    let loaded = load(&cwd, Some(Path::new("../../settings/native.json"))).unwrap();
    assert_eq!(loaded.invocation_cwd, cwd);
    assert_eq!(loaded.project_root, root);
    assert_eq!(loaded.config_dir, root.join("settings"));
    assert_eq!(
        loaded.config.sort.unwrap()["web"]
            .base_dir
            .as_ref()
            .unwrap(),
        &root.join("apps/web")
    );
    assert_eq!(loaded.config.workspace.package_globs, vec!["apps/*"]);
}

#[test]
fn explicit_empty_globs_skip_workspace_file_before_using_fallback() {
    let temporary = TempDir::new().unwrap();
    write(
        temporary.path(),
        "pnpm-workspace.yaml",
        "packages: [services/*]",
    );
    write(
        temporary.path(),
        "env-lane.config.json",
        r#"{"workspace":{"packageGlobs":[]}}"#,
    );
    let loaded = load(temporary.path(), None).unwrap();
    assert_eq!(
        loaded.config.workspace.package_globs,
        vec!["packages/*", "apps/*"]
    );
}

#[test]
fn discovery_prioritizes_native_formats_and_fails_closed_for_executable_config() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    write(root, "package.json", "{}");
    write(
        root,
        "env-lane.config.ts",
        "throw new Error('must never execute')",
    );
    assert_eq!(
        load(root, None).unwrap_err().code,
        "CONFIG_COMPILATION_REQUIRED"
    );
    write(root, "env-lane.config.yaml", "selector: { envKey: YAML }");
    write(
        root,
        "env-lane.config.json",
        r#"{"selector":{"envKey":"JSON"}}"#,
    );
    assert_eq!(load(root, None).unwrap().config.selector.env_key, "JSON");
    assert_eq!(
        load(root, Some(Path::new("env-lane.config.yaml")))
            .unwrap()
            .config
            .selector
            .env_key,
        "YAML"
    );
}

#[test]
fn root_markers_match_the_frozen_file_only_discovery_contract() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    fs::create_dir_all(root.join(".git")).unwrap();
    let child = root.join("child");
    fs::create_dir(&child).unwrap();
    assert_eq!(find_root(&child), child);
    write(root, "package.json", "{}");
    assert_eq!(find_root(&child), root);
}

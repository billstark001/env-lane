use env_lane_core::{
    check::{CheckOptions, check_selector},
    config,
    policy::{SyncOptions, run_check, run_sync},
    resolve::{Context, Environment},
    workspace,
};
use serde_json::{Value, json};
use std::fs;
use tempfile::TempDir;

fn project(config: Value, files: &[(&str, &str)]) -> TempDir {
    let temporary = TempDir::new().unwrap();
    fs::write(temporary.path().join("package.json"), r#"{"name":"app"}"#).unwrap();
    fs::write(
        temporary.path().join("env-lane.config.json"),
        config.to_string(),
    )
    .unwrap();
    for (name, content) in files {
        let path = temporary.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    temporary
}

#[test]
fn rules_distinguish_missing_mismatched_and_aligned_values() {
    let temporary = project(
        json!({"checks":{"deploy":{"sources":{"a":{"file":"a.env","includeProcessEnv":true},"b":{"file":"b.env"}},"rules":[
            {"type":"requiredAny","source":"a","keys":["MISSING","TOKEN"]},
            {"type":"requiredAny","source":"a","keys":["MISSING","ALSO_MISSING"]},
            {"type":"equals","left":{"source":"a","key":"URL"},"right":{"source":"b","key":"URL"},"transform":"url-base"},
            {"type":"equals","left":{"source":"a","key":"MISSING"},"right":{"source":"b","key":"URL"}},
            {"type":"equals","left":{"source":"a","key":"TOKEN"},"right":{"source":"b","key":"TOKEN"},"label":"tokens","severity":"warn"}
        ]}}}),
        &[
            ("a.env", "TOKEN=first\nURL=https://example.invalid/\n"),
            ("b.env", "TOKEN=second\nURL=https://example.invalid\n"),
        ],
    );
    let loaded = config::load(temporary.path(), None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    let environment = Environment::from([("MISSING".into(), "process-only".into())]);
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &environment,
    };
    let result = run_check(&context, "deploy", None, &mut Vec::new()).unwrap();
    assert!(!result.ok);
    assert_eq!(
        json!(result.summary),
        json!({"ok":2,"warnings":2,"errors":1})
    );
    assert_eq!(result.findings[0].message, "a has TOKEN");
    assert_eq!(result.findings[2].message, "a.URL == b.URL aligned");
    assert_eq!(result.findings[3].message, "a.MISSING == b.URL skipped");
    assert_eq!(result.findings[4].message, "tokens mismatch");
    assert_eq!(
        run_check(&context, "missing", None, &mut Vec::new())
            .unwrap_err()
            .code,
        "UNKNOWN_ENV_CHECK"
    );
}

#[test]
fn sync_preview_does_not_create_destination_and_writes_restore_last_occurrence() {
    let temporary = project(
        json!({"sync":{"copy":{"from":{"file":"source.env"},"to":{"file":"nested/.env.{variant}"},"mappings":[{"from":"SOURCE","to":"KEY","transform":"trim"},{"from":"MISSING","to":"SKIPPED"}]}}}),
        &[("source.env", "SOURCE=' value '\n")],
    );
    let loaded = config::load(temporary.path(), None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    let environment = Environment::new();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &environment,
    };
    let preview = run_sync(
        &context,
        "copy",
        &SyncOptions {
            dry_run: true,
            build: None,
        },
        &mut Vec::new(),
    )
    .unwrap();
    assert!(!preview.changed);
    assert!(preview.write.is_none());
    assert!(!temporary.path().join("nested").exists());
    fs::create_dir(temporary.path().join("nested")).unwrap();
    let file = temporary.path().join("nested/.env.local");
    fs::write(&file, "\u{feff}KEY=old\r\n# KEY = dormant # retain\r\n").unwrap();
    let result = run_sync(&context, "copy", &SyncOptions::default(), &mut Vec::new()).unwrap();
    assert!(result.changed);
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "\u{feff}KEY = value # retain\r\n"
    );
    let write = result.write.unwrap();
    assert_eq!(write.removed_duplicate_keys, vec!["KEY"]);
    assert_eq!(write.restored_commented_keys, vec!["KEY"]);
    assert!(
        !run_sync(&context, "copy", &SyncOptions::default(), &mut Vec::new())
            .unwrap()
            .changed
    );
}

#[test]
fn selector_scan_includes_all_visible_variants_and_excludes_generated_directories() {
    let temporary = project(
        json!({"selector":{"envKey":"LANE"}}),
        &[
            (".env", "LANE=local\n"),
            ("app.env.test", "LANE=test\n"),
            ("nested/.env.production", "LANE=production\n"),
            ("node_modules/.env", "LANE=ignored\n"),
            (".hidden/.env", "LANE=ignored\n"),
            ("dist/.env", "LANE=ignored\n"),
            (".secret.env", "LANE=ignored\n"),
        ],
    );
    let loaded = config::load(temporary.path(), None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    let environment = Environment::new();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &environment,
    };
    let result = check_selector(
        &context,
        &CheckOptions {
            target: Some("all"),
            require_override: Some(true),
            build: None,
        },
        &mut Vec::new(),
    )
    .unwrap();
    assert!(!result.ok);
    assert_eq!(
        result
            .violations
            .iter()
            .map(|entry| entry.relative_file.as_str())
            .collect::<Vec<_>>(),
        vec![".env", "app.env.test", "nested/.env.production"]
    );
    assert_eq!(result.missing_required.len(), 1);
    assert_eq!(result.missing_required[0].relative_file, ".env.local");
}

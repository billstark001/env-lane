use env_lane_core::{
    config,
    document::effective_values,
    sort::{ConfiguredOptions, SortOptions, build_plan, sort_configured, sort_file},
};
use proptest::prelude::*;
use std::fs;
use tempfile::TempDir;

#[test]
fn check_mode_preserves_bytes_and_missing_file_create_policy() {
    let temporary = TempDir::new().unwrap();
    let file = temporary.path().join(".env");
    let template = temporary.path().join(".env.example");
    let skipped = sort_file(
        &file,
        &template,
        &SortOptions {
            create: false,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!skipped.changed);
    assert!(!file.exists());
    fs::write(&template, "A=\nB=\n").unwrap();
    fs::write(&file, "B=two\nA=one\n").unwrap();
    let result = sort_file(
        &file,
        &template,
        &SortOptions {
            check: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(result.changed);
    assert!(!result.applied);
    assert_eq!(fs::read_to_string(file).unwrap(), "B=two\nA=one\n");
}

#[cfg(unix)]
#[test]
fn configured_sort_rejects_filesystem_root_as_file_without_panicking() {
    let temporary = TempDir::new().unwrap();
    fs::write(
        temporary.path().join("env-lane.config.json"),
        r#"{"sort":{"bad":{"file":"/"}}}"#,
    )
    .unwrap();
    let loaded = config::load(temporary.path(), None).unwrap();
    let error = sort_configured(
        &loaded,
        &[],
        Some("bad"),
        Some("production"),
        &ConfiguredOptions::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "SORT_INVALID_CONFIG");
}

proptest! {
    #[test]
    fn sorting_preserves_effective_values_and_is_idempotent(entries in prop::collection::vec((0usize..4, "[a-z0-9]{0,15}"),0..30)) {
        let keys=["A","B","C","D"];
        let content=entries.iter().map(|(key,value)|format!("{}={value}\n",keys[*key])).collect::<String>();
        let template="A=\nB=\nC=\nD=\n";
        let first=build_plan(Some(&content),template,&SortOptions::default());
        prop_assert_eq!(effective_values(&content),effective_values(&first.next_content));
        let second=build_plan(Some(&first.next_content),template,&SortOptions::default());
        prop_assert!(!second.changed);
    }
}

use env_lane_core::{
    config,
    document::effective_values,
    sort::{ConfiguredOptions, SortOptions, Status, sort_configured, sort_file},
    workspace,
};
use std::{fs, path::Path};
use tempfile::TempDir;

fn options(root: &Path) -> SortOptions {
    SortOptions {
        sync_dir: Some(root.join("state")),
        ..Default::default()
    }
}
fn write(root: &Path, file: &str, text: &str) {
    fs::write(root.join(file), text).unwrap();
}

#[test]
fn creation_is_explicit_and_checks_never_initialize_state() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    write(root, "template", "A=default\n");
    let file = root.join(".env");
    let template = root.join("template");
    let skipped = sort_file(&file, &template, &options(root)).unwrap();
    assert_eq!(skipped.status, Status::Missing);
    assert!(!file.exists());
    assert!(!root.join("state").exists());
    let preview = sort_file(
        &file,
        &template,
        &SortOptions {
            create: true,
            check: true,
            ..options(root)
        },
    )
    .unwrap();
    assert!(preview.changed);
    assert!(!root.join("state").exists());
    sort_file(
        &file,
        &template,
        &SortOptions {
            create: true,
            ..options(root)
        },
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "# A=default\n");
    assert!(root.join("state/sort-sync-state.json").exists());
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("state/sort-sync-state.json")).unwrap())
            .unwrap();
    assert!(saved["files"].get(r#"[".env","template"]"#).is_some());
}

#[test]
fn fields_sync_independently_and_local_notes_survive() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(
        root,
        "template",
        "# heading\nA=one # old inline\n\n# old B\n# B=old\n",
    );
    write(
        root,
        ".env",
        "# heading\nA=one # old inline\n\n# old B\n# local note\n# B=old\n",
    );
    sort_file(&file, &template, &options(root)).unwrap();
    write(
        root,
        "template",
        "# new heading\nA=two # new inline\n\n# new B\n# B=new\n",
    );
    let result = sort_file(&file, &template, &options(root)).unwrap();
    assert!(result.conflicts.is_empty());
    let content = fs::read_to_string(&file).unwrap();
    assert!(content.contains("A=two # new inline"));
    assert!(content.contains("# B=new"));
    assert!(content.contains("# new B"));
    assert!(content.contains("# local note"));
    assert!(!content.contains("old B"));
    assert!(!content.contains("old inline"));
    assert!(content.starts_with("# new heading"));
    assert!(!sort_file(&file, &template, &options(root)).unwrap().changed);
}

#[test]
fn conflicts_persist_until_local_matches_template_without_caching_secrets() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, "template", "A=one # old\n\n# comment\nB=one\n");
    write(root, ".env", "A=one # old\n\n# comment\nB=one\n");
    sort_file(&file, &template, &options(root)).unwrap();
    write(
        root,
        ".env",
        "A=private-local-value # personal\n\n# local comment\nB=one\n",
    );
    // Local-only edits must not cause the unchanged template comment to reappear.
    sort_file(&file, &template, &options(root)).unwrap();
    let before = fs::read_to_string(&file).unwrap();
    assert!(!before.contains("\n# comment\n"));
    write(
        root,
        "template",
        "A=two # new\n\n# updated comment\nB=two\n",
    );
    for _ in 0..2 {
        let result = sort_file(&file, &template, &options(root)).unwrap();
        assert_eq!(result.conflicts.len(), 3);
        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("A=private-local-value # personal"));
        assert!(content.contains("# local comment"));
        assert!(!content.contains("updated comment"));
        assert_eq!(effective_values(&content)["B"], "two");
    }
    let saved = fs::read_to_string(root.join("state/sort-sync-state.json")).unwrap();
    assert!(!saved.contains("private-local-value"));
    assert!(!saved.contains("personal"));
    write(root, ".env", "A=two # new\n\n# updated comment\nB=two\n");
    assert!(
        sort_file(&file, &template, &options(root))
            .unwrap()
            .conflicts
            .is_empty()
    );
}

#[test]
fn each_destination_has_its_own_ancestry_and_check_keeps_state_bytes() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let template = root.join("template");
    write(root, "template", "A=one\n");
    write(root, "a.env", "A=one\n");
    write(root, "b.env", "A=one\n");
    for name in ["a.env", "b.env"] {
        sort_file(&root.join(name), &template, &options(root)).unwrap();
    }
    write(root, "template", "A=two\n");
    let state_path = root.join("state/sort-sync-state.json");
    let state = fs::read(&state_path).unwrap();
    assert!(
        sort_file(
            &root.join("a.env"),
            &template,
            &SortOptions {
                check: true,
                ..options(root)
            }
        )
        .unwrap()
        .changed
    );
    assert_eq!(fs::read(&state_path).unwrap(), state);
    assert_eq!(fs::read_to_string(root.join("a.env")).unwrap(), "A=one\n");
    for name in ["a.env", "b.env"] {
        sort_file(&root.join(name), &template, &options(root)).unwrap();
        assert_eq!(
            effective_values(&fs::read_to_string(root.join(name)).unwrap())["A"],
            "two"
        );
    }
}

#[test]
fn multiline_active_values_and_inline_comments_round_trip() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, "template", "A=\"line one\nline two\" # old\n");
    write(root, ".env", "A=\"line one\nline two\" # old\n");
    sort_file(&file, &template, &options(root)).unwrap();
    write(root, "template", "A=\"new one\nnew two\" # new\n");
    let result = sort_file(&file, &template, &options(root)).unwrap();
    assert!(result.conflicts.is_empty());
    let content = fs::read_to_string(&file).unwrap();
    assert_eq!(effective_values(&content)["A"], "new one\nnew two");
    assert!(content.contains("# new"));
    assert!(!content.contains("# old"));
}

#[test]
fn aliases_share_defaults_and_default_suffix_is_configurable() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    fs::create_dir(root.join("backend")).unwrap();
    write(root, "package.json", "{}");
    write(root, "backend/package.json", "{\"name\":\"api-package\"}");
    write(
        root,
        "env-lane.config.json",
        r#"{"selector":{"sortDefaultsKey":"_defaults","builds":["local"]},"workspace":{"includeRoot":false,"packageGlobs":["backend"],"aliases":{"api":"backend","go":"backend"}},"sort":{"_defaults":{"create":false,"suffixes":["default","local"],"targets":["api"]},"backend":{"files":{"default":".env.shared"}},"default":{"baseDir":"backend","enabled":false}},"dotenv":{"localOverrideFile":".env.private"}}"#,
    );
    write(root, "backend/.env.example", "A=\nB=\n");
    write(root, "backend/.env.shared", "B=2\nA=1\n");
    let loaded = config::load(root, None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    let result = sort_configured(
        &loaded,
        &packages,
        Some("go"),
        Some("default"),
        &ConfiguredOptions::default(),
    )
    .unwrap();
    assert_eq!(
        result.results[0].file_path,
        root.join("backend/.env.shared")
    );
    let skipped = sort_configured(
        &loaded,
        &packages,
        Some("api"),
        Some("local"),
        &ConfiguredOptions::default(),
    )
    .unwrap();
    assert_eq!(skipped.missing_count, 1);
    assert_eq!(skipped.count, 0);
    assert_eq!(
        skipped.results[0].file_path,
        root.join("backend/.env.private")
    );
    assert!(
        sort_configured(
            &loaded,
            &packages,
            Some("api"),
            Some("typo"),
            &ConfiguredOptions::default()
        )
        .is_err()
    );
    assert!(!root.join("backend/.env.typo").exists());
}

#[test]
fn shadowed_template_defaults_do_not_change_the_accepted_baseline() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, ".env", "A=one\n");
    write(root, "template", "A=one\nA=shadowed\n");
    sort_file(&file, &template, &options(root)).unwrap();
    assert!(!sort_file(&file, &template, &options(root)).unwrap().changed);
    write(root, "template", "A=one\nA=other-shadowed\n");
    assert!(!sort_file(&file, &template, &options(root)).unwrap().changed);
    write(root, "template", "A=two\nA=shadowed\n");
    assert!(
        sort_file(&file, &template, &options(root))
            .unwrap()
            .conflicts
            .is_empty()
    );
    assert_eq!(
        effective_values(&fs::read_to_string(file).unwrap())["A"],
        "two"
    );
}

#[test]
fn invalid_state_and_duplicates_fail_conservatively() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, ".env", "A=one\nA=one\n");
    write(root, "template", "A=one\n");
    sort_file(&file, &template, &options(root)).unwrap();
    write(root, "template", "A=two\n");
    let result = sort_file(&file, &template, &options(root)).unwrap();
    assert_eq!(result.conflicts[0].field, "duplicate-entry");
    assert_eq!(
        effective_values(&fs::read_to_string(&file).unwrap())["A"],
        "one"
    );
    write(root, "state/sort-sync-state.json", "broken");
    let before = fs::read(&file).unwrap();
    assert_eq!(
        sort_file(&file, &template, &options(root))
            .unwrap_err()
            .code,
        "SORT_STATE_INVALID"
    );
    assert_eq!(fs::read(&file).unwrap(), before);
}

#[test]
fn inactive_multiline_defaults_sync_without_activation() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, "template", "A=\"old one\nold two\" # old\nB=public\n");
    sort_file(
        &file,
        &template,
        &SortOptions {
            create: true,
            ..options(root)
        },
    )
    .unwrap();
    write(root, "template", "A=\"new one\nnew two\" # new\nB=public\n");
    let result = sort_file(&file, &template, &options(root)).unwrap();
    assert!(result.conflicts.is_empty());
    let content = fs::read_to_string(&file).unwrap();
    assert!(effective_values(&content).is_empty());
    assert!(content.contains("new one"));
    assert!(!content.contains("old two"));
    assert!(!sort_file(&file, &template, &options(root)).unwrap().changed);
}

#[test]
fn defaults_key_can_be_renamed_for_a_target_named_default() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    write(root, "package.json", "{}");
    write(
        root,
        "env-lane.config.json",
        r#"{"selector":{"sortDefaultsKey":"settings"},"sort":{"settings":{"create":false},"default":{"baseDir":"."}}}"#,
    );
    write(root, ".env", "B=two\nA=one\n");
    write(root, ".env.example", "A=\nB=\n");
    let loaded = config::load(root, None).unwrap();
    let result = sort_configured(
        &loaded,
        &[],
        Some("default"),
        Some("default"),
        &ConfiguredOptions::default(),
    )
    .unwrap();
    assert!(result.applied);
    assert_eq!(result.count, 1);
    assert_eq!(
        fs::read_to_string(root.join(".env")).unwrap(),
        "A=one\nB=two\n"
    );
}

#[test]
#[cfg(unix)]
fn missing_destinations_under_symlinked_directories_are_sorted_once() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    fs::create_dir(root.join("actual")).unwrap();
    std::os::unix::fs::symlink(root.join("actual"), root.join("link")).unwrap();
    write(root, "package.json", "{}");
    write(root, "actual/.env.example", "A=one\n");
    write(
        root,
        "env-lane.config.json",
        r#"{"sort":{"default":{"create":true,"suffixes":["default"]},"a":{"baseDir":"actual"},"b":{"baseDir":"link"}}}"#,
    );
    let loaded = config::load(root, None).unwrap();
    let result = sort_configured(&loaded, &[], None, None, &ConfiguredOptions::default()).unwrap();
    assert_eq!(result.count, 1);
    assert_eq!(
        fs::read_to_string(root.join("actual/.env")).unwrap(),
        "# A=one\n"
    );
}

#[test]
fn batch_selection_is_validated_before_writing_and_aliases_deduplicate() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    fs::create_dir(root.join("backend")).unwrap();
    write(root, "package.json", "{}");
    write(root, "backend/package.json", r#"{"name":"backend"}"#);
    write(root, "backend/.env.example", "A=\nB=\n");
    write(root, "backend/.env", "B=two\nA=one\n");
    write(
        root,
        "env-lane.config.json",
        r#"{"workspace":{"includeRoot":false,"packageGlobs":["backend"],"aliases":{"api":"backend","go":"backend"}},"sort":{"default":{"targets":["api","go"],"suffixes":["default"]},"api":{},"go":{}}}"#,
    );
    let loaded = config::load(root, None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    let error = sort_configured(
        &loaded,
        &packages,
        None,
        Some("unknown"),
        &ConfiguredOptions::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "SORT_UNKNOWN_SUFFIX");
    assert_eq!(
        fs::read_to_string(root.join("backend/.env")).unwrap(),
        "B=two\nA=one\n"
    );
    assert!(!root.join(".env-lane-cache").exists());
    let result = sort_configured(
        &loaded,
        &packages,
        None,
        None,
        &ConfiguredOptions::default(),
    )
    .unwrap();
    assert_eq!(result.count, 1);
    assert!(root.join(".env-lane-cache/sort-sync-state.json").exists());
    assert!(!root.join("backend/.env-lane-cache").exists());
    write(
        root,
        "env-lane.config.json",
        r#"{"workspace":{"includeRoot":false,"packageGlobs":["backend"],"aliases":{"api":"backend","go":"backend"}},"sort":{"api":{"create":true},"go":{"create":false}}}"#,
    );
    let loaded = config::load(root, None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    assert_eq!(
        sort_configured(
            &loaded,
            &packages,
            None,
            None,
            &ConfiguredOptions::default()
        )
        .unwrap_err()
        .code,
        "SORT_AMBIGUOUS_CONFIG"
    );
    write(
        root,
        "env-lane.config.json",
        r#"{"workspace":{"includeRoot":false,"packageGlobs":["backend"],"aliases":{"api":"backend","go":"backend"}},"sort":{"default":{"suffixes":["default"]},"api":{},"go":{"create":false,"enabled":true,"file":".env","template":".env.example","unlistedVariablesComment":""}}}"#,
    );
    let loaded = config::load(root, None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    assert_eq!(
        sort_configured(
            &loaded,
            &packages,
            None,
            None,
            &ConfiguredOptions::default()
        )
        .unwrap()
        .count,
        1
    );
}

#[test]
fn cached_updates_preserve_bom_and_crlf_and_checks_keep_bytes() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, ".env", "\u{feff}# header\r\nA=one # old\r\nB=two\r\n");
    write(root, "template", "# header\nA=one # old\nB=two\n");
    sort_file(&file, &template, &options(root)).unwrap();
    write(root, "template", "# new header\nB=two\nA=new # changed\n");
    let env_bytes = fs::read(&file).unwrap();
    let state_path = root.join("state/sort-sync-state.json");
    let state_bytes = fs::read(&state_path).unwrap();
    let preview = sort_file(
        &file,
        &template,
        &SortOptions {
            check: true,
            ..options(root)
        },
    )
    .unwrap();
    assert!(preview.changed);
    assert!(preview.conflicts.is_empty());
    assert_eq!(fs::read(&file).unwrap(), env_bytes);
    assert_eq!(fs::read(&state_path).unwrap(), state_bytes);
    sort_file(&file, &template, &options(root)).unwrap();
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "\u{feff}# new header\r\nB=two\r\nA=new # changed\r\n"
    );
    assert!(!sort_file(&file, &template, &options(root)).unwrap().changed);
}

#[test]
fn state_lock_serializes_writers_and_preview_stays_read_only() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    write(root, ".env", "A=one\n");
    write(root, "template", "A=one\n");
    fs::create_dir(root.join("state")).unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("state/sort-sync-state.lock"))
        .unwrap();
    fs2::FileExt::lock_exclusive(&lock).unwrap();
    let error = sort_file(&root.join(".env"), &root.join("template"), &options(root)).unwrap_err();
    assert_eq!(error.code, "SORT_STATE_BUSY");
    sort_file(
        &root.join(".env"),
        &root.join("template"),
        &SortOptions {
            check: true,
            ..options(root)
        },
    )
    .unwrap();
    assert!(!root.join("state/sort-sync-state.json").exists());
    drop(lock);
    sort_file(&root.join(".env"), &root.join("template"), &options(root)).unwrap();
}

#[test]
fn file_header_stays_before_entries_when_template_order_changes() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    write(root, ".env", "# heading\nA=one\nB=two\n");
    write(root, "template", "# heading\nA=one\nB=two\n");
    let file = root.join(".env");
    let template = root.join("template");
    sort_file(&file, &template, &options(root)).unwrap();
    write(root, "template", "# heading\nB=two\nA=one\n");
    sort_file(&file, &template, &options(root)).unwrap();
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "# heading\nB=two\nA=one\n"
    );
    write(root, "template", "# updated heading\nB=two\nA=one\n");
    assert!(
        sort_file(&file, &template, &options(root))
            .unwrap()
            .conflicts
            .is_empty()
    );
    assert!(
        fs::read_to_string(file)
            .unwrap()
            .starts_with("# updated heading\n")
    );
}

#[test]
fn multiline_inline_comments_may_contain_quotes() {
    for inactive in [false, true] {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path();
        let file = root.join(".env");
        let template = root.join("template");
        let original = "A=\"one\ntwo\" # say \"old\"\n";
        write(root, "template", original);
        if !inactive {
            write(root, ".env", original);
        }
        let options = SortOptions {
            create: true,
            ..options(root)
        };
        sort_file(&file, &template, &options).unwrap();
        write(root, "template", "A=\"new one\nnew two\" # say \"new\"\n");
        let result = sort_file(&file, &template, &options).unwrap();
        assert!(result.conflicts.is_empty());
        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("# say \"new\""), "{content}");
        assert!(!content.contains("# say \"old\""));
        assert!(!sort_file(&file, &template, &options).unwrap().changed);
    }
}

#[test]
fn first_multiline_definition_owns_its_value_even_with_shadowed_definitions() {
    for inactive in [false, true] {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path();
        let prefix = if inactive { "# " } else { "" };
        write(
            root,
            "template",
            &format!("{prefix}A=\"one\n{prefix}two\"\n{prefix}A=shadowed\n"),
        );
        write(root, ".env", &format!("{prefix}A=\"one\n{prefix}two\"\n"));
        let file = root.join(".env");
        let template = root.join("template");
        sort_file(&file, &template, &options(root)).unwrap();
        write(
            root,
            "template",
            &format!("{prefix}A=\"new one\n{prefix}new two\"\n{prefix}A=shadowed\n"),
        );
        let result = sort_file(&file, &template, &options(root)).unwrap();
        assert!(
            result.conflicts.is_empty(),
            "{inactive}: {:?}",
            result.conflicts
        );
        assert!(fs::read_to_string(&file).unwrap().contains("new one"));
    }
}

#[test]
fn inactive_multiline_templates_keep_continuation_indentation_and_comment_depth() {
    for inactive_template in [false, true] {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path();
        let prefix = if inactive_template { "# " } else { "" };
        write(
            root,
            "template",
            &format!("{prefix}A=\"one\n{prefix}  two\"\n"),
        );
        let file = root.join(".env");
        let template = root.join("template");
        sort_file(
            &file,
            &template,
            &SortOptions {
                create: true,
                ..options(root)
            },
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "# A=\"one\n#   two\"\n");
        write(
            root,
            "template",
            &format!("{prefix}A=\"new one\n{prefix}  new two\"\n"),
        );
        assert!(
            sort_file(&file, &template, &options(root))
                .unwrap()
                .conflicts
                .is_empty()
        );
    }
}

#[test]
fn template_comment_updates_preserve_interleaved_local_notes_and_normalized_blanks() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let original = "A=one\n\n\n# first\n# second\nB=two\n";
    write(root, "template", original);
    write(root, ".env", original);
    let file = root.join(".env");
    let template = root.join("template");
    sort_file(&file, &template, &options(root)).unwrap();
    write(
        root,
        ".env",
        "A=one\n\n# first\n# local note\n# second\nB=two\n",
    );
    write(
        root,
        "template",
        "A=one\n\n\n# changed first\n# changed second\nB=two\n",
    );
    let result = sort_file(&file, &template, &options(root)).unwrap();
    assert!(result.conflicts.is_empty());
    let content = fs::read_to_string(&file).unwrap();
    assert!(
        content.contains("# changed first\n# local note\n# changed second"),
        "{content}"
    );
    assert!(!sort_file(&file, &template, &options(root)).unwrap().changed);
}

#[test]
fn explicit_recreation_discards_old_ownership_and_creates_even_an_empty_template() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    let creation = SortOptions {
        create: true,
        ..options(root)
    };
    write(root, "template", "# old header\nA=old\n# old footer\n");
    sort_file(&file, &template, &creation).unwrap();
    fs::remove_file(&file).unwrap();
    write(root, "template", "# new header\nA=new\n# new footer\n");
    let result = sort_file(&file, &template, &creation).unwrap();
    assert!(result.conflicts.is_empty());
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "# new header\n# A=new\n# new footer\n"
    );
    fs::remove_file(&file).unwrap();
    write(root, "template", "");
    let preview = sort_file(
        &file,
        &template,
        &SortOptions {
            check: true,
            ..creation
        },
    )
    .unwrap();
    assert!(preview.changed);
    assert!(!file.exists());
    let result = sort_file(
        &file,
        &template,
        &SortOptions {
            create: true,
            ..options(root)
        },
    )
    .unwrap();
    assert!(result.applied);
    assert_eq!(fs::read_to_string(file).unwrap(), "");
}

#[test]
fn comment_ownership_ambiguity_keeps_local_content_and_conflicts_persist() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, "template", "A=one\n# old\nB=two\n");
    write(root, ".env", "A=one\n# old\nB=two\n");
    sort_file(&file, &template, &options(root)).unwrap();
    write(root, ".env", "A=one\n# old\n# local note\n# old\nB=two\n");
    write(root, "template", "A=one\n# new\nB=three\n");
    for _ in 0..2 {
        let result = sort_file(&file, &template, &options(root)).unwrap();
        assert!(
            result
                .conflicts
                .iter()
                .any(|conflict| conflict.field == "leading-comment")
        );
        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("# old\n# local note\n# old"));
        assert_eq!(effective_values(&content)["B"], "three");
    }
    write(root, ".env", "A=one\n# new\n# local note\nB=three\n");
    assert!(
        sort_file(&file, &template, &options(root))
            .unwrap()
            .conflicts
            .is_empty()
    );
}

#[test]
fn manually_accepted_comment_blocks_do_not_leave_obsolete_template_lines() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, "template", "A=one\n# common\n# old\nB=two\n");
    write(root, ".env", "A=one\n# common\n# old\nB=two\n");
    sort_file(&file, &template, &options(root)).unwrap();
    write(root, "template", "A=one\n# common\n# new\nB=two\n");
    write(
        root,
        ".env",
        "A=one\n# common\n# old\n# local note\n# new\nB=two\n",
    );
    let result = sort_file(&file, &template, &options(root)).unwrap();
    assert!(result.conflicts.is_empty());
    let content = fs::read_to_string(&file).unwrap();
    assert!(!content.contains("# old"));
    assert!(content.contains("# common\n# local note\n# new"));
    assert!(!sort_file(&file, &template, &options(root)).unwrap().changed);
}

#[test]
fn structurally_valid_but_corrupt_cache_fails_before_env_or_state_writes() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path();
    let file = root.join(".env");
    let template = root.join("template");
    write(root, ".env", "A=one\n");
    write(root, "template", "A=one\n");
    sort_file(&file, &template, &options(root)).unwrap();
    let state_path = root.join("state/sort-sync-state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    state["files"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()["entries"]["A"]["valueFingerprint"] = "broken".into();
    fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    write(root, "template", "A=two\n");
    let before = fs::read(&state_path).unwrap();
    for check in [false, true] {
        let result = sort_file(
            &file,
            &template,
            &SortOptions {
                check,
                ..options(root)
            },
        )
        .unwrap_err();
        assert_eq!(result.code, "SORT_STATE_INVALID");
        assert_eq!(fs::read_to_string(&file).unwrap(), "A=one\n");
        assert_eq!(fs::read(&state_path).unwrap(), before);
    }
}

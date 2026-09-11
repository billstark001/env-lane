use env_lane_vault::{
    crypto,
    record::{self, Change},
    store::{self, ReadOptions, Scope},
};
use serde_json::Value;
use std::{fs, path::Path};

#[test]
fn store_remaps_legacy_paths_and_uses_timestamp_then_append_order() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../compat/fixtures/vault/schema-v0-v1.json"
    ))
    .unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let managed = [base.join(".env")];
    let scope = Scope {
        base_dir: base,
        invocation_cwd: base,
        managed_files: &managed,
        auto_remap_paths: true,
    };
    let key = crypto::derive_key(fixture["keyMaterialUtf8"].as_str().unwrap().as_bytes()).unwrap();
    let mut lines: Vec<_> = fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["ciphertext"].as_str().unwrap().to_owned())
        .collect();
    for (time, value) in [(1700000001000_u64, "tie wins"), (1, "older ignored")] {
        let plain =
            serde_json::json!({"version":1,"f":".env","k":"MODERN","t":time,"op":"set","v":value})
                .to_string();
        lines.push(crypto::encrypt_record(&key, &plain).unwrap());
    }
    let path = base.join("store.dat");
    fs::write(&path, format!("\u{feff}\r\n{}\r\n\n", lines.join("\r\n"))).unwrap();
    let loaded = store::read(&path, &key, &scope, &ReadOptions::default()).unwrap();
    assert_eq!(
        (
            loaded.raw_records,
            loaded.parsed_records,
            loaded.aliased_records
        ),
        (4, 4, 1)
    );
    let state = &loaded.state[&managed[0]];
    let Change::Set(legacy) = &state["LEGACY"].change else {
        panic!("legacy set")
    };
    assert_eq!(legacy.as_str(), "legacy # raw");
    let Change::Set(modern) = &state["MODERN"].change else {
        panic!("modern set")
    };
    assert_eq!(modern.as_str(), "tie wins");
    let serialized = record::encode(&state["LEGACY"], base).unwrap();
    let wire: Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(wire["version"], 1);
    assert_eq!(wire["f"], ".env");
    assert_eq!(wire["v"], "legacy # raw");
    lines.push("corrupt-record".into());
    fs::write(&path, lines.join("\n")).unwrap();
    let error = store::read(&path, &key, &scope, &ReadOptions::default())
        .err()
        .unwrap();
    assert_eq!(error.code, "VAULT_CORRUPT_STORE");
    let partial = store::read(
        &path,
        &key,
        &scope,
        &ReadOptions {
            ignore_corrupt_records: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(partial.failed_records, 1);
    fs::write(&path, "corrupt-record").unwrap();
    let error = store::read(
        &path,
        &key,
        &scope,
        &ReadOptions {
            ignore_corrupt_records: true,
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert_eq!(error.code, "VAULT_NO_READABLE_RECORDS");
}

#[test]
fn portable_record_paths_reject_platform_specific_paths_but_preserve_relative_parents() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    for invalid in [
        "",
        "/absolute",
        "C:/absolute",
        "C:relative",
        "folder\\file",
        "a\0b",
    ] {
        assert!(record::resolve_record_path(base, invalid).is_err());
    }
    assert_eq!(
        record::resolve_record_path(base, "../shared/.env").unwrap(),
        base.parent().unwrap().join("shared/.env")
    );
    assert_eq!(record::encode_record_path(base, base).unwrap(), ".");
    let deleted = record::decode(
        r#"{"version":1,"f":".env","k":"A","t":0,"op":"delete"}"#,
        base,
        Path::new("/"),
        3,
    )
    .unwrap();
    assert!(matches!(deleted.change, Change::Delete));
}

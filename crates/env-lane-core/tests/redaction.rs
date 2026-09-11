use env_lane_core::redaction::{self, Options};
use regex::Regex;

#[test]
fn explicit_policy_and_minimum_length_are_applied_before_value_detection() {
    let options = Options {
        allow_keys: vec![Regex::new("^PASSWORD$").unwrap()],
        deny_keys: vec![Regex::new("^PUBLIC_KEY$").unwrap()],
        ..Default::default()
    };
    assert_eq!(
        redaction::redact("PASSWORD", "synthetic-text", &options),
        "synthetic-text"
    );
    assert_eq!(
        redaction::redact("PUBLIC_KEY", "synthetic-text", &options),
        "<redacted>"
    );
    assert_eq!(redaction::redact("PUBLIC_KEY", "short", &options), "short");
    let options = Options {
        show_secrets: true,
        ..options
    };
    assert_eq!(
        redaction::redact("PUBLIC_KEY", "synthetic-text", &options),
        "synthetic-text"
    );
}

#[test]
fn safe_public_material_requires_matching_pem_labels() {
    let options = Options {
        min_entropy_length: 8,
        min_character_classes: 1,
        entropy_threshold: 0.0,
        ..Default::default()
    };
    let matching = "-----BEGIN PUBLIC KEY-----synthetic-----END PUBLIC KEY-----";
    assert!(!redaction::is_secret_value(matching, &options));
    assert!(redaction::is_secret_value(
        "-----BEGIN PRIVATE KEY-----synthetic-----END PRIVATE KEY-----",
        &options
    ));
    assert!(redaction::is_secret_key("HTTPAccessToken", &options));
    assert!(!redaction::is_secret_key(
        "VITE_SUPABASE_ANON_KEY",
        &options
    ));
}

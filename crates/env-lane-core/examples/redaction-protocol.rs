//! Test-only transport for detection and formatting decisions.
use env_lane_core::redaction::{self, Options};
use serde_json::{Value, json};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let key = request["key"].as_str().unwrap();
        let value = request["value"].as_str().unwrap();
        let options = Options::default();
        println!(
            "{}",
            json!({
                "key":redaction::is_secret_key(key, &options),
                "value":redaction::is_secret_value(value, &options),
                "jwt":redaction::is_jwt(value),
                "paseto":redaction::is_paseto(value),
                "entropy":redaction::is_high_entropy(value, &options),
                "redacted":redaction::redact(key, value, &options),
            })
        );
    }
}

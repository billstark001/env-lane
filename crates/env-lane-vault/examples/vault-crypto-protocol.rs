//! Test-only crypto transport. No derived key material is returned.
use env_lane_vault::crypto;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};
fn main() {
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let key = crypto::load_key(Path::new(request["keyFile"].as_str().unwrap())).unwrap();
        let decrypt: Vec<_> = request["decrypt"]
            .as_array()
            .unwrap()
            .iter()
            .map(
                |value| match crypto::decrypt_record(&key, value.as_str().unwrap()) {
                    Ok(value) => json!({"plaintext":value.as_str()}),
                    Err(error) => json!({"error":error.code}),
                },
            )
            .collect();
        let encrypt: Vec<_> = request["encrypt"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| crypto::encrypt_record(&key, value.as_str().unwrap()).unwrap())
            .collect();
        let sync_key = crypto::derive_sync_key(&key);
        println!(
            "{}",
            json!({"decrypt":decrypt,"encrypt":encrypt,"fingerprint":crypto::keyed_digest(&sync_key, request["fingerprint"].as_str().unwrap().as_bytes())})
        );
    }
}

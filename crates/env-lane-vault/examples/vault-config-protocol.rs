//! Test-only native Vault configuration transport.
use env_lane_core::config;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};
fn main() {
    for input in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&input.unwrap()).unwrap();
        let loaded = config::load(
            Path::new(request["cwd"].as_str().unwrap()),
            request["mainConfig"].as_str().map(Path::new),
        )
        .unwrap();
        let result =
            env_lane_vault::config::load(&loaded, request["vaultConfig"].as_str().map(Path::new));
        println!(
            "{}",
            match result {
                Ok(config) => json!(config),
                Err(error) => json!({"error":error.code,"message":error.message}),
            }
        );
    }
}

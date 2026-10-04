//! Test-only native Vault restore transport.
use env_lane_core::config;
use env_lane_vault::{crypto, restore};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};

fn main() {
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let cwd = Path::new(request["cwd"].as_str().unwrap());
        let loaded = config::load(cwd, request["mainConfig"].as_str().map(Path::new)).unwrap();
        let vault =
            env_lane_vault::config::load(&loaded, request["vaultConfig"].as_str().map(Path::new))
                .unwrap();
        let key = crypto::load_key(Path::new(request["keyFile"].as_str().unwrap())).unwrap();
        let mut options = restore::Options::new(cwd);
        options.sync_dir = request["syncDir"].as_str().map(Path::new);
        let result = if request["operation"] == "apply" {
            let submitted: restore::Plan = serde_json::from_value(request["plan"].clone()).unwrap();
            let mut apply = restore::ApplyOptions::new(cwd);
            apply.read = options;
            apply.auto_approve = request["autoApprove"].as_bool().unwrap_or(false);
            restore::apply(&vault, &key, &submitted, &apply).map(|value| json!(value))
        } else {
            restore::build(&vault, &key, &options).map(|value| json!(value))
        };
        println!(
            "{}",
            match result {
                Ok(value) => value,
                Err(error) => json!({"error":error.code,"message":error.message}),
            }
        );
    }
}

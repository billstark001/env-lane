//! Test-only native Vault push transport.
use env_lane_core::config;
use env_lane_vault::{crypto, push};
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
        let mut options = push::Options::new(cwd);
        options.dry_run = request["dryRun"].as_bool().unwrap_or(false);
        options.skip_missing_files = request["skipMissing"].as_bool().unwrap_or(false);
        options.sync_dir = request["syncDir"].as_str().map(Path::new);
        let result = push::execute(&vault, &key, &options);
        println!(
            "{}",
            match result {
                Ok(value) => json!(value),
                Err(error) => json!({"error":error.code,"message":error.message}),
            }
        );
    }
}

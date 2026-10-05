//! Test-only config transport; output adaptation lives at the consumer boundary.
use env_lane_core::{check, config, policy, resolve, workspace};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};

fn main() {
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let cwd = Path::new(request["cwd"].as_str().unwrap());
        let explicit = request["configFile"].as_str().map(Path::new);
        let response = match config::load(cwd, explicit) {
            Ok(loaded) => match request["operation"].as_str() {
                Some("packages") => match workspace::list_packages(&loaded) {
                    Ok(packages) => json!(packages),
                    Err(error) => json!({"error":error.code,"message":error.message}),
                },
                Some(
                    operation @ ("files" | "resolve" | "policyCheck" | "sync" | "selectorCheck"),
                ) => {
                    let packages = workspace::list_packages(&loaded).unwrap();
                    let environment = serde_json::from_value(
                        request.get("processEnv").cloned().unwrap_or(json!({})),
                    )
                    .unwrap();
                    let context = resolve::Context {
                        loaded: &loaded,
                        packages: &packages,
                        process_env: &environment,
                    };
                    let options = resolve::Options {
                        target: request["target"].as_str(),
                        build: request["build"].as_str(),
                        include_process_env: Some(false),
                        require_override: request["requireOverride"].as_bool(),
                    };
                    let mut diagnostics = Vec::new();
                    let result = match operation {
                        "files" => context
                            .files(&options, &mut diagnostics)
                            .map(|result| json!(result)),
                        "selectorCheck" => check::check_selector(
                            &context,
                            &check::CheckOptions {
                                target: options.target,
                                build: options.build,
                                require_override: options.require_override,
                            },
                            &mut diagnostics,
                        )
                        .map(|result| json!(result)),
                        "policyCheck" => policy::run_check(
                            &context,
                            request["name"].as_str().unwrap(),
                            options.build,
                            &mut diagnostics,
                        )
                        .map(|result| json!(result)),
                        "sync" => policy::run_sync(
                            &context,
                            request["name"].as_str().unwrap(),
                            &policy::SyncOptions {
                                build: options.build,
                                dry_run: request["dryRun"].as_bool().unwrap_or(false),
                            },
                            &mut diagnostics,
                        )
                        .map(|result| json!(result)),
                        _ => context
                            .resolve(&options, &mut diagnostics)
                            .map(|result| json!(result)),
                    };
                    result
                        .unwrap_or_else(|error| json!({"error":error.code,"message":error.message}))
                }
                Some("resolveTarget") => {
                    let packages = workspace::list_packages(&loaded).unwrap();
                    match workspace::resolve_target(
                        &packages,
                        request["target"].as_str(),
                        &loaded.config.workspace.default_target,
                        Some(&loaded.invocation_cwd),
                    ) {
                        Ok(package) => json!(package),
                        Err(error) => json!({"error":error.code,"message":error.message}),
                    }
                }
                _ => {
                    let mut result = serde_json::to_value(loaded.config).unwrap();
                    result["rootDir"] = json!(loaded.project_root);
                    result
                }
            },
            Err(error) => json!({"error":error.code}),
        };
        println!("{response}");
    }
}

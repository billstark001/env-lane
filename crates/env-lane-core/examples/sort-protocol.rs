//! Test transport for pure sort plans and actual file operations.
use env_lane_core::sort::{SortOptions, build_plan, sort_file};
use env_lane_core::{config, workspace};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};
fn main() {
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let options: SortOptions =
            serde_json::from_value(request.get("options").cloned().unwrap_or(json!({}))).unwrap();
        let result = if request["operation"] == "configured" {
            let loaded = config::load(
                Path::new(request["cwd"].as_str().unwrap()),
                Some(Path::new("env-lane.config.json")),
            )
            .unwrap();
            let packages = workspace::list_packages(&loaded).unwrap();
            match env_lane_core::sort::sort_configured(
                &loaded,
                &packages,
                request["key"].as_str(),
                request["variant"].as_str(),
                &env_lane_core::sort::ConfiguredOptions {
                    check: options.check,
                    create: request["options"]["create"].as_bool(),
                    preserve_bom: request["options"]["preserveBOM"].as_bool(),
                    eol: request["options"]
                        .get("eol")
                        .map(|value| serde_json::from_value(value.clone()).unwrap()),
                },
            ) {
                Ok(result) => json!(result),
                Err(error) => json!({"error":error.code}),
            }
        } else if request["operation"] == "file" {
            match sort_file(
                Path::new(request["file"].as_str().unwrap()),
                Path::new(request["template"].as_str().unwrap()),
                &options,
            ) {
                Ok(result) => json!(result),
                Err(error) => json!({"error":error.code}),
            }
        } else {
            json!(build_plan(
                request["content"].as_str(),
                request["template"].as_str().unwrap(),
                &options
            ))
        };
        println!("{result}");
    }
}

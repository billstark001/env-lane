//! Test-only transport. This is deliberately not a public native CLI or compatibility API.
use env_lane_core::document::{
    Document, Patch, PatchOptions, effective_values, format_value, patch,
};
use serde_json::{Value, json};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = match input["op"].as_str().unwrap() {
            "parse" => {
                let content = input["content"].as_str().unwrap();
                json!({"document":Document::parse(content),"values":effective_values(content)})
            }
            "format" => match format_value(input["value"].as_str().unwrap()) {
                Ok(value) => json!({"value":value}),
                Err(error) => json!({"error":error.code}),
            },
            "patch" => {
                let patches: Vec<Patch> = serde_json::from_value(input["patches"].clone()).unwrap();
                let options: PatchOptions =
                    serde_json::from_value(input.get("options").cloned().unwrap_or(json!({})))
                        .unwrap();
                match patch(input["content"].as_str().unwrap(), &patches, &options) {
                    Ok(result) => json!(result),
                    Err(error) => json!({"error":error.code}),
                }
            }
            _ => panic!("Unknown test operation"),
        };
        println!("{result}");
    }
}

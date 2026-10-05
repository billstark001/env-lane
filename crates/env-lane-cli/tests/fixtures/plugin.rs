//! Protocol fixture: deliberately small and only built with `plugin-fixture`.
use env_lane_plugin_api::{
    Capability, CommandInvocation, CommandResult, DocumentFilterInput, DocumentFilterResult,
    Handler, LineRange, Manifest, PluginError, ProvidedValue, ValueRequest, ValueResult, process,
};
use serde_json::Value;

struct Fixture;

impl Handler for Fixture {
    fn invoke(
        &mut self,
        method: &str,
        params: &serde_json::value::RawValue,
    ) -> Result<Value, PluginError> {
        let result = match method {
            "command.invoke" => {
                let input: CommandInvocation = serde_json::from_str(params.get()).unwrap();
                println!("fixture-command:{}", input.arguments.join(","));
                serde_json::to_value(CommandResult { exit_code: 7 }).unwrap()
            }
            "document.filter" => {
                let input: DocumentFilterInput = serde_json::from_str(params.get()).unwrap();
                let local = input.file_id.ends_with(".env.local");
                let condition = if local { "A" } else { "FROM_SOURCE" };
                let available = input
                    .lookup
                    .iter()
                    .any(|item| item.key == condition && item.present);
                serde_json::to_value(DocumentFilterResult {
                    disabled_lines: if available && local {
                        vec![
                            LineRange { start: 1, end: 1 },
                            LineRange { start: 3, end: 3 },
                        ]
                    } else if available {
                        vec![
                            LineRange { start: 2, end: 2 },
                            LineRange { start: 4, end: 4 },
                        ]
                    } else if local {
                        vec![LineRange { start: 1, end: 3 }]
                    } else {
                        vec![LineRange { start: 2, end: 4 }]
                    },
                })
                .unwrap()
            }
            "env.source" => {
                let input: ValueRequest = serde_json::from_str(params.get()).unwrap();
                serde_json::to_value(ValueResult {
                    values: input
                        .keys
                        .into_iter()
                        .map(|key| ProvidedValue {
                            key,
                            value: "fixture-secret".into(),
                            sensitive: true,
                        })
                        .collect(),
                })
                .unwrap()
            }
            "env.generate" => {
                let input: ValueRequest = serde_json::from_str(params.get()).unwrap();
                serde_json::to_value(ValueResult {
                    values: input
                        .keys
                        .into_iter()
                        .map(|key| ProvidedValue {
                            key,
                            value: input.run_id.clone(),
                            sensitive: false,
                        })
                        .collect(),
                })
                .unwrap()
            }
            _ => {
                return Err(PluginError {
                    code: "PLUGIN_METHOD_NOT_FOUND".into(),
                    message: method.into(),
                    details: None,
                });
            }
        };
        Ok(result)
    }
}

fn main() {
    if std::env::args().any(|arg| arg == "--probe") {
        for key in ["A", "B", "FROM_SOURCE", "PAIR_A", "PAIR_B"] {
            println!("{key}={}", std::env::var(key).unwrap_or_default());
        }
        return;
    }
    let manifest = Manifest {
        id: "fixture".into(),
        executable: std::env::current_exe().unwrap(),
        arguments: Vec::new(),
        capabilities: vec![
            Capability::Command {
                name: "example".into(),
            },
            Capability::DocumentFilter,
            Capability::EnvSource,
            Capability::EnvGenerate,
        ],
    };
    process::serve(&manifest, &mut Fixture).unwrap();
}

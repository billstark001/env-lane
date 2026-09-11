//! Node is only a development oracle. This test is explicitly invoked by the
//! checksum-verifying JS harness and is excluded from the no-Node native suite.
use base64::{Engine, engine::general_purpose::STANDARD};
use env_lane_core::document::{Document, Patch, PatchOptions, patch};
use proptest::{
    prelude::*,
    test_runner::{Config, TestRunner},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

struct Oracle {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Oracle {
    fn start() -> Self {
        let node =
            std::env::var_os("ENV_LANE_TEST_NODE").expect("run through rust-document-fuzz.mjs");
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/compat/document-oracle.mjs");
        let mut child = Command::new(node)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn evaluate(&mut self, request: Value) -> Value {
        writeln!(
            self.input,
            "{}",
            STANDARD.encode(serde_json::to_vec(&request).unwrap())
        )
        .unwrap();
        self.input.flush().unwrap();
        let mut response = String::new();
        assert_ne!(
            self.output.read_line(&mut response).unwrap(),
            0,
            "oracle terminated unexpectedly"
        );
        serde_json::from_slice(&STANDARD.decode(response.trim()).unwrap()).unwrap()
    }
}
impl Drop for Oracle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn content_strategy() -> impl Strategy<Value = String> {
    let atoms = prop::sample::select(vec![
        "A=",
        "B: ",
        "export A=",
        "# A=",
        "INVALID",
        "'",
        "\"",
        "`",
        "#",
        "\\",
        "\\n",
        "\\r",
        "\n",
        "\r\n",
        " ",
        "🦀",
        "\u{feff}",
        "\u{85}",
        "\u{2028}",
        "\u{2029}",
    ]);
    prop::collection::vec(atoms, 0..40).prop_map(|atoms| atoms.concat())
}

#[test]
#[ignore = "requires the verified frozen Node oracle"]
fn generated_document_and_patch_differential_with_shrinking() {
    let oracle = std::cell::RefCell::new(Oracle::start());
    let strategy = (
        content_strategy(),
        "[a-zA-Z #`'\"\\\\\n\r]{0,30}",
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
    );
    let mut runner = TestRunner::new(Config {
        cases: 512,
        source_file: Some(file!()),
        ..Config::default()
    });
    runner
        .run(
            &strategy,
            |(content, value, delete, last, commented, duplicates, blank_line)| {
                let expected = oracle
                    .borrow_mut()
                    .evaluate(json!({"operation": "parse", "content": content}));
                prop_assert_eq!(json!(Document::parse(&content)), expected);
                let patches = if delete {
                    vec![Patch::Delete { key: "A".into() }]
                } else {
                    vec![
                        Patch::Set {
                            key: "A".into(),
                            value: value.clone(),
                        },
                        Patch::Set {
                            key: "B".into(),
                            value,
                        },
                    ]
                };
                let options = json!({
                    "update": if last { "last" } else { "all" },
                    "matchCommented": commented,
                    "removeDuplicateEntries": duplicates,
                    "blankLineBeforeAdditions": blank_line,
                });
                let native_options: PatchOptions = serde_json::from_value(options.clone()).unwrap();
                let request = json!({
                    "operation": "patch",
                    "content": content,
                    "patches": patches,
                    "options": options,
                });
                let expected = oracle.borrow_mut().evaluate(request);
                let actual = match patch(&content, &patches, &native_options) {
                    Ok(result) => json!(result),
                    Err(error) => json!({"error": error.code}),
                };
                prop_assert_eq!(actual, expected);
                Ok(())
            },
        )
        .unwrap();
}

#![cfg(feature = "plugin-fixture")]
use std::{fs, process::Command};

#[test]
fn native_plugins_filter_and_provide_without_node() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::write(
        root.join(".env"),
        "A=base\n# IFDEF FROM_SOURCE\nB=active\n# ENDIF\n",
    )
    .unwrap();
    fs::write(
        root.join(".env.local"),
        "# IFDEF A\nC=from-earlier-file\n# ENDIF\n",
    )
    .unwrap();
    let plugin = env!("CARGO_BIN_EXE_env-lane-test-plugin");
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let platform = if cfg!(target_os = "windows") {
        format!("win32-{arch}-msvc")
    } else if cfg!(target_os = "linux") {
        format!(
            "linux-{arch}-{}",
            if cfg!(target_env = "musl") {
                "musl"
            } else {
                "gnu"
            }
        )
    } else {
        format!(
            "{}-{arch}",
            if cfg!(target_os = "macos") {
                "darwin"
            } else {
                std::env::consts::OS
            }
        )
    };
    let binary_name = if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    };
    let package_dir = root.join("node_modules/fixture-plugin");
    let binary_dir = root.join("node_modules/fixture-native");
    fs::create_dir_all(&package_dir).unwrap();
    fs::create_dir_all(&binary_dir).unwrap();
    fs::copy(plugin, binary_dir.join(binary_name)).unwrap();
    fs::write(
        binary_dir.join("package.json"),
        r#"{"name":"fixture-native"}"#,
    )
    .unwrap();
    fs::write(package_dir.join("package.json"), serde_json::to_vec(&serde_json::json!({
        "name":"fixture-plugin",
        "envLanePlugin": {
            "protocolVersion":1,
            "id":"fixture",
            "capabilities":[{"kind":"command","name":"example"},{"kind":"documentFilter"},{"kind":"envSource"},{"kind":"envGenerate"}],
            "entry":{"kind":"native","platforms":{platform:{"package":"fixture-native","path":binary_name}}}
        }
    })).unwrap()).unwrap();
    fs::write(root.join("fixture.json"), "{}").unwrap();
    fs::write(
        root.join("env-lane.config.json"),
        serde_json::to_vec(&serde_json::json!({
            "fixture": {
                "enabled":true, "configFile":"fixture.json", "packageName":"fixture-plugin",
                "documentFilter":true,
                "filterLookup":["FROM_SOURCE", "A"], "sourceKeys":["FROM_SOURCE"],
                "generators":[{"group":"pair","keys":["PAIR_A","PAIR_B"]}]
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let cli = env!("CARGO_BIN_EXE_env-lane");
    let result = Command::new(cli)
        .args([
            "--cwd",
            root.to_str().unwrap(),
            "--json",
            "print",
            ".",
            "--no-process-env",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let output: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(output["A"]["value"], "base");
    assert_eq!(output["B"]["value"], "active");
    assert_eq!(output["C"]["value"], "from-earlier-file");
    assert_eq!(output["FROM_SOURCE"]["value"], "<redacted>");
    assert_eq!(output["FROM_SOURCE"]["source"]["source"], "plugin");
    let result = Command::new(cli)
        .args([
            "--cwd",
            root.to_str().unwrap(),
            "run",
            ".",
            plugin,
            "--probe",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text = String::from_utf8(result.stdout).unwrap();
    let pair_a = text
        .lines()
        .find_map(|line| line.strip_prefix("PAIR_A="))
        .unwrap();
    let pair_b = text
        .lines()
        .find_map(|line| line.strip_prefix("PAIR_B="))
        .unwrap();
    assert_eq!(pair_a, pair_b);
    assert_eq!(
        text.lines().find_map(|line| line.strip_prefix("B=")),
        Some("active")
    );
    let command = Command::new(cli)
        .args(["--cwd", root.to_str().unwrap(), "example", "hello"])
        .output()
        .unwrap();
    assert_eq!(command.status.code(), Some(7));
    assert_eq!(
        String::from_utf8(command.stdout).unwrap(),
        "fixture-command:example,hello\n"
    );
}

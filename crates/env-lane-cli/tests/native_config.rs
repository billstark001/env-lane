#[cfg(unix)]
#[test]
fn run_uses_declarative_configs_without_node_on_path() {
    use std::{fs, process::Command};

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::write(root.join(".env"), "VALUE=from-dotenv\n").unwrap();
    let cli = env!("CARGO_BIN_EXE_env-lane");
    for (extension, content) in [
        ("json", "{dotenv:{order:['.env']}}"),
        (
            "jsonc",
            "{ // comment\n \"dotenv\": {\"order\": [\".env\",],},}",
        ),
        ("json5", "{dotenv:{order:['.env'],},}"),
        ("toml", "[dotenv]\norder = ['.env']\n"),
    ] {
        let path = root.join(format!("env-lane.config.{extension}"));
        fs::write(&path, content).unwrap();
        let result = Command::new(cli)
            .args([
                "--cwd",
                root.to_str().unwrap(),
                "--config",
                path.to_str().unwrap(),
                "run",
                ".",
                "--quiet",
                "/usr/bin/env",
            ])
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{extension}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(
            String::from_utf8_lossy(&result.stdout).contains("VALUE=from-dotenv"),
            "{extension}"
        );
    }
}

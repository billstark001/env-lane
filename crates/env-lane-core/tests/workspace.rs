use env_lane_core::{config, workspace};
use std::fs;

#[cfg(unix)]
#[test]
fn linked_directory_cycle_does_not_hide_other_workspace_packages() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let app = root.join("packages/app");
    fs::create_dir_all(&app).unwrap();
    fs::write(root.join("package.json"), r#"{"name":"root"}"#).unwrap();
    fs::write(
        root.join("pnpm-workspace.yaml"),
        "packages:\n  - packages/**\n",
    )
    .unwrap();
    fs::write(app.join("package.json"), r#"{"name":"app"}"#).unwrap();
    symlink(root.join("packages"), app.join("back")).unwrap();

    let loaded = config::load(root, None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    assert!(
        packages
            .iter()
            .any(|package| package.name.as_deref() == Some("app"))
    );
}

#[test]
fn generated_name_in_project_ancestor_does_not_hide_packages() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("dist/project");
    let app = root.join("packages/app");
    fs::create_dir_all(&app).unwrap();
    fs::write(root.join("package.json"), r#"{"name":"root"}"#).unwrap();
    fs::write(
        root.join("pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n",
    )
    .unwrap();
    fs::write(app.join("package.json"), r#"{"name":"app"}"#).unwrap();

    let loaded = config::load(&root, None).unwrap();
    let packages = workspace::list_packages(&loaded).unwrap();
    assert_eq!(
        packages.iter().filter(|package| !package.is_root).count(),
        1
    );
}

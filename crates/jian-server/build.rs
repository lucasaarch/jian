//! Build the embedded self-hosted web panel when its Cargo capability is enabled.

use std::{env, error::Error, io, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_WEB_PANEL");
    if env::var_os("CARGO_FEATURE_WEB_PANEL").is_none() {
        return Ok(());
    }

    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("Cargo did not provide CARGO_MANIFEST_DIR"))?;
    let workspace_root = manifest_dir.join("../..");
    let panel_dir = workspace_root.join("apps/desktop-tauri");

    for path in [
        workspace_root.join("package.json"),
        workspace_root.join("pnpm-lock.yaml"),
        workspace_root.join("pnpm-workspace.yaml"),
        panel_dir.join("package.json"),
        panel_dir.join("index.html"),
        panel_dir.join("tsconfig.json"),
        panel_dir.join("vite.config.ts"),
        panel_dir.join("src"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let status = Command::new("pnpm")
        .args(["--filter", "@jian/desktop-tauri", "build:web"])
        .current_dir(&workspace_root)
        .status()
        .map_err(|error| {
            io::Error::other(format!(
                "could not build the self-hosted web panel; ensure Node.js 24+ and pnpm 11 are installed: {error}"
            ))
        })?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "self-hosted web panel build failed with status {status}"
        ))
        .into());
    }

    Ok(())
}

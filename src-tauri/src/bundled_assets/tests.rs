use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    root: PathBuf,
    resource: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "reqora-assets-{label}-{}-{stamp}",
            std::process::id()
        ));
        let resource = root.join("resources");
        let home = root.join("home");
        fs::create_dir_all(resource.join(RESOURCE_FOLDER)).unwrap();
        fs::create_dir_all(&home).unwrap();
        Self { root, resource, home }
    }

    /// Add one file to the staged bundle and its manifest entry.
    fn add(&self, rel: &str, bytes: &[u8], version: &str) -> ManifestFile {
        let path = self.resource.join(RESOURCE_FOLDER).join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        let entries: Vec<ManifestFile> = {
            let manifest_path = self.resource.join(RESOURCE_FOLDER).join(MANIFEST_FILE);
            if manifest_path.is_file() {
                let parsed: Manifest =
                    serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
                parsed.files
            } else {
                Vec::new()
            }
        };
        let mut files: Vec<serde_json::Value> = Vec::new();
        let mut pushed = false;
        for entry in entries {
            if entry.target == rel {
                // Re-adding the same target (version bump) replaces its bytes.
                files.push(json!({ "target": rel, "sha256": sha256_hex(bytes) }));
                pushed = true;
            } else {
                files.push(json!({ "target": entry.target, "sha256": entry.sha256 }));
            }
        }
        if !pushed {
            files.push(json!({ "target": rel, "sha256": sha256_hex(bytes) }));
        }
        fs::write(
            self.resource.join(RESOURCE_FOLDER).join(MANIFEST_FILE),
            serde_json::to_string_pretty(&json!({ "version": version, "files": files })).unwrap(),
        )
        .unwrap();
        ManifestFile {
            target: rel.into(),
            sha256: sha256_hex(bytes),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn missing_bundle_is_not_an_error() {
    let fixture = Fixture::new("missing");
    assert_eq!(
        install_from_dirs(&fixture.resource, &fixture.home).unwrap(),
        InstallOutcome::NoBundle
    );
}

#[test]
fn first_install_copies_files_and_writes_config_and_marker() {
    let fixture = Fixture::new("first");
    fixture.add("mcp/mcp.mjs", b"// mcp bundle", "0.0.2");
    fixture.add("skills/reqora-mcp/SKILL.md", b"# skill", "0.0.2");
    fixture.add("bin/reqora-send", b"binary-stub", "0.0.2");

    assert_eq!(
        install_from_dirs(&fixture.resource, &fixture.home).unwrap(),
        InstallOutcome::Installed {
            version: "0.0.2".into(),
            files: 3
        }
    );

    assert_eq!(
        fs::read(fixture.home.join("mcp/mcp.mjs")).unwrap(),
        b"// mcp bundle"
    );
    assert_eq!(
        fs::read(fixture.home.join("skills/reqora-mcp/SKILL.md")).unwrap(),
        b"# skill"
    );
    assert_eq!(
        fs::read(fixture.home.join("bin/reqora-send")).unwrap(),
        b"binary-stub"
    );
    assert_eq!(
        fs::read_to_string(fixture.home.join(VERSION_MARKER)).unwrap(),
        "0.0.2"
    );
    let config = fs::read_to_string(fixture.home.join("mcp/CONFIG.md")).unwrap();
    let expected_entry = fixture.home.join("mcp").join("mcp.mjs");
    assert!(config.contains(&expected_entry.display().to_string()));
    assert!(config.contains("mcpServers"));
}

#[test]
fn second_install_is_up_to_date() {
    let fixture = Fixture::new("uptodate");
    fixture.add("mcp/mcp.mjs", b"// mcp", "0.0.2");
    assert!(matches!(
        install_from_dirs(&fixture.resource, &fixture.home).unwrap(),
        InstallOutcome::Installed { .. }
    ));
    assert_eq!(
        install_from_dirs(&fixture.resource, &fixture.home).unwrap(),
        InstallOutcome::UpToDate
    );
}

#[test]
fn deleted_file_is_repaired_on_next_launch() {
    let fixture = Fixture::new("repair");
    fixture.add("mcp/mcp.mjs", b"// mcp", "0.0.2");
    install_from_dirs(&fixture.resource, &fixture.home).unwrap();
    fs::remove_file(fixture.home.join("mcp/mcp.mjs")).unwrap();
    assert_eq!(
        install_from_dirs(&fixture.resource, &fixture.home).unwrap(),
        InstallOutcome::Installed {
            version: "0.0.2".into(),
            files: 1
        }
    );
    assert!(fixture.home.join("mcp/mcp.mjs").is_file());
}

#[test]
fn version_change_reinstalls() {
    let fixture = Fixture::new("bump");
    fixture.add("mcp/mcp.mjs", b"v1", "0.0.2");
    install_from_dirs(&fixture.resource, &fixture.home).unwrap();
    fixture.add("mcp/mcp.mjs", b"v2", "0.0.1");
    assert_eq!(
        install_from_dirs(&fixture.resource, &fixture.home).unwrap(),
        InstallOutcome::Installed {
            version: "0.0.1".into(),
            files: 1
        }
    );
    assert_eq!(fs::read(fixture.home.join("mcp/mcp.mjs")).unwrap(), b"v2");
}

#[test]
fn tampered_checksum_is_rejected() {
    let fixture = Fixture::new("tamper");
    let mut entry = fixture.add("mcp/mcp.mjs", b"good", "0.0.2");
    entry.sha256 = "deadbeef".into();
    fs::write(
        fixture.resource.join(RESOURCE_FOLDER).join(MANIFEST_FILE),
        serde_json::to_string(&json!({
            "version": "0.0.2",
            "files": [{ "target": entry.target, "sha256": entry.sha256 }]
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(install_from_dirs(&fixture.resource, &fixture.home)
        .unwrap_err()
        .contains("校验失败"));
}

#[test]
fn path_traversal_is_rejected() {
    let fixture = Fixture::new("traversal");
    fs::write(
        fixture.resource.join(RESOURCE_FOLDER).join(MANIFEST_FILE),
        serde_json::to_string(&json!({
            "version": "0.0.2",
            "files": [{ "target": "../escape.txt", "sha256": "00" }]
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(install_from_dirs(&fixture.resource, &fixture.home)
        .unwrap_err()
        .contains("非法的安装目标路径"));
    assert!(!fixture.root.join("escape.txt").exists());
}

#[test]
fn config_markdown_uses_installed_home_paths() {
    let home = std::env::temp_dir().join("reqora-config-test");
    let text = config_markdown(&home, "reqora-send");
    assert!(text.contains(&home.join("mcp").join("mcp.mjs").display().to_string()));
    assert!(text.contains(&home.join("bin").join("reqora-send").display().to_string()));
    assert!(text.contains("--allow-write"));
}

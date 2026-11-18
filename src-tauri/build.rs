fn main() {
    // tauri_build only watches tauri.conf.json and capabilities by default.
    // Without these, swapping icons/*.png|ico leaves a stale icon embedded in
    // the compiled exe (window + taskbar icon), so Cargo must rebuild on change.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // config.rs bakes these two values into release binaries via option_env!.
    // .env.production changes must trigger a rebuild, otherwise an installed
    // release keeps checking the old endpoint (or none at all).
    println!("cargo:rerun-if-env-changed=REQORA_UPDATE_MANIFEST_URL");
    println!("cargo:rerun-if-env-changed=REQORA_UPDATE_VERIFY_TLS");
    tauri_build::build()
}

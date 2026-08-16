fn main() {
    // Force cargo to re-embed icons whenever the source icon changes.
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}

fn main() {
    // Client IDs live in ../.env (see .env.example); they are public identifiers, not secrets.
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-env-changed=WANDIKA_PUBLIC");
    if let Ok(iter) = dotenvy::from_path_iter("../.env") {
        for (key, value) in iter.flatten() {
            if key.starts_with("WANDIKA_") {
                println!("cargo:rustc-env={key}={value}");
            }
        }
    }
    tauri_build::build()
}

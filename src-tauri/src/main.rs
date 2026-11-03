// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `wandika mcp`: the MCP server for Claude Code, on stdin and stdout, with no window.
    #[cfg(desktop)]
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        std::process::exit(wandika_lib::mcp_main());
    }
    wandika_lib::run()
}

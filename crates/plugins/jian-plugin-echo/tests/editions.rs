//! The build carries the plugins of its capabilities. `make rust-editions` runs this with and
//! without `local-process`; the workspace default has it.

use jian_plugin_echo::plugins;

#[test]
fn the_build_has_the_plugins_of_its_capabilities() {
    let ids: Vec<&str> = plugins().iter().map(|p| p.id()).collect();
    assert!(
        ids.contains(&"echo"),
        "a plugin of every build is in every build"
    );
    assert_eq!(
        ids.contains(&"echolocal"),
        cfg!(feature = "local-process"),
        "a local-process plugin is in a build with that capability and only there: {ids:?}"
    );
}

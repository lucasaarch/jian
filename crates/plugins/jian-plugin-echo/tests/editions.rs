//! The build carries the plugins of its edition. `make rust-check` runs this both ways: with the
//! default features and with `--no-default-features --features cloud`.

use jian_plugin_echo::plugins;

#[test]
fn the_build_has_the_plugins_of_its_edition() {
    let ids: Vec<&str> = plugins().iter().map(|p| p.id()).collect();
    assert!(
        ids.contains(&"echo"),
        "a plugin of both editions is in every build"
    );
    assert_eq!(
        ids.contains(&"echolocal"),
        cfg!(feature = "self-hosted"),
        "a self-hosted plugin is in the self-hosted build and only there: {ids:?}"
    );
}

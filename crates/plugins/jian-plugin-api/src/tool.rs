//! A tool a plugin exposes for one of its accounts.

use serde_json::Value;

/// A tool as the plugin declares it. The name the model sees is made from this one, the plugin
/// and the account ([`PluginRegistry::resolve`](crate::PluginRegistry::resolve)), so two accounts
/// of one plugin give two tools that do not collide.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolDef {
    /// The plugin's name for it: lowercase letters, digits and `_`.
    pub name: &'static str,
    /// What the model reads of it.
    pub description: String,
    /// The JSON Schema of its input.
    pub input_schema: Value,
    /// It only reads: it changes nothing, at the service or anywhere else. A run that may only
    /// suggest (an agent in `suggest` mode woken by an event) has these and no other, the same
    /// meaning as the runtime's `Tool::read_only`. The default of a tool is no; say yes only when
    /// it is true.
    pub read_only: bool,
}

//! The command line: a command, then flags and `--name value` options in any order.

pub struct Args {
    pub command: Option<String>,
    list: Vec<String>,
}

impl Args {
    /// `--version`, `-V` and `version` win over any command, so `jian-remote --version update`
    /// still only prints the version.
    pub fn parse(list: Vec<String>) -> Self {
        let wants_version = list.iter().any(|arg| arg == "--version" || arg == "-V");
        let first = list
            .first()
            .filter(|first| !first.starts_with('-'))
            .cloned();
        let command = if wants_version {
            Some("version".into())
        } else {
            first
        };
        Self { command, list }
    }

    pub fn flag(&self, names: &[&str]) -> bool {
        self.list.iter().any(|arg| names.contains(&arg.as_str()))
    }

    pub fn option(&self, names: &[&str]) -> Option<&str> {
        let at = self
            .list
            .iter()
            .position(|arg| names.contains(&arg.as_str()))?;
        self.list.get(at + 1).map(String::as_str)
    }

    /// Everything after the command, for one that passes its arguments on.
    pub fn rest(&self) -> Vec<String> {
        self.list.iter().skip(1).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Args {
        Args::parse(line.split_whitespace().map(String::from).collect())
    }

    #[test]
    fn reads_commands_flags_and_options() {
        let args = parse("install --system --gateway https://jian.example.com --token-stdin");
        assert_eq!(args.command.as_deref(), Some("install"));
        assert!(args.flag(&["--system"]));
        assert_eq!(
            args.option(&["--gateway"]),
            Some("https://jian.example.com")
        );
        assert_eq!(
            parse("--version update").command.as_deref(),
            Some("version")
        );
        assert_eq!(parse("--json").command, None);
        assert_eq!(parse("logs -n 20").option(&["--lines", "-n"]), Some("20"));
    }
}

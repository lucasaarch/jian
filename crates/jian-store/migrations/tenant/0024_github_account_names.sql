-- A GitHub installation's name is what the agent uses to pick it (`github__<name>__...`), so two
-- of them may not share one, whatever the capitals. Other plugins keep allowing repeats (two MCP
-- servers may both be called "docs"). The store turns a violation into a conflict.
CREATE UNIQUE INDEX connector_accounts_github_name ON connector_accounts (lower(name))
    WHERE plugin = 'github';

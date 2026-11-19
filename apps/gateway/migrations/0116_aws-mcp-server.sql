-- AWS accounts move from the awslabs AWS API MCP server, which AWS no longer develops, to AWS's
-- managed MCP server through its SigV4 proxy. Only the command's arguments change: the keys and
-- the region stay in the vault, under the server's name. The region is there, out of SQL's
-- reach, so every account is signed for the N. Virginia server; its AWS_REGION still decides
-- where the calls operate. Tools switched off by name are cleared, since the new server's tools
-- have other names.
UPDATE "mcp_servers"
SET "server" = jsonb_set(
      jsonb_set("server", '{args}', '["mcp-proxy-for-aws-cli@latest", "https://aws-mcp.us-east-1.api.aws/mcp"]'::jsonb),
      '{disabledTools}', '[]'::jsonb
    ),
    "updated_at" = now()
WHERE "server"->>'command' = 'uvx'
  AND "server"->'args'->>0 = 'awslabs.aws-api-mcp-server@latest';

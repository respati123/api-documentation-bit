# api-documentation-mcp

Local MCP server for the API Documentation desktop app. It reads the same local SQLite database as the app, so the desktop app must be installed and opened at least once on this computer.

## Use with an AI client

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "api-documentation": {
      "command": "npx",
      "args": ["-y", "api-documentation-mcp"]
    }
  }
}
```

For Codex:

```
codex mcp add api-documentation -- npx -y api-documentation-mcp
```

Requires Node.js 22 or newer.

## Data location

The server uses the same data folder as the desktop app:

- Linux: `~/.config/api-documentation-bit`
- macOS: `~/Library/Application Support/api-documentation-bit`
- Windows: `%APPDATA%\api-documentation-bit`

Set `API_DOCS_USER_DATA_DIR` in the client configuration if the app uses a custom data folder.

## Tools

- `list_workspaces`
- `get_collection_tree`
- `search_requests`
- `get_request`
- `preview_changes`
- `apply_changes`

`apply_changes` writes local drafts. Keep the desktop app open to see changes immediately. Changes are shared only after they are committed and pushed from the desktop app.

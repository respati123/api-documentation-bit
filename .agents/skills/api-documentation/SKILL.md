---
name: api-documentation
description: Use the API Documentation local MCP server to inspect and maintain endpoint collections for frontend integration.
---

# API Documentation Workflow

- Use `list_workspaces` to identify the target workspace. Ask if more than one workspace could match.
- Search or read the existing request before creating a duplicate.
- Preserve existing request IDs, folder structure, auth configuration, and unrelated fields when editing.
- Treat the following as the endpoint completeness standard. Include every applicable item when its facts are available; a field being optional in the MCP schema does not make useful API details optional in the documentation.
  - **Identity:** meaningful request name, HTTP method, and route.
  - **Parameters:** path parameters in `pathParams`; query parameters in `params`; include known values and descriptions. Keep URL query text and `params` in sync. Describe whether a parameter is required when known.
  - **Headers:** document endpoint-specific required or useful headers, with descriptions and safe example values where known. Keep body mode/content type consistent; do not add transport-generated headers or duplicate a content type managed by the request body setting.
  - **Body:** for endpoints that accept a payload, record its mode/content type and a representative body or fields. Use `bodyMode: "none"` when the endpoint has no body.
  - **Auth:** record the known auth type and inheritance behavior, but never expose real credentials or secret values.
  - **Variables:** use `{{variableName}}` for reusable or environment-dependent values instead of hard-coding them. Prefer `{{baseUrl}}` for a changing host and `{{apiPrefix}}` when the API prefix varies. Use a variable only when the value is genuinely shared, configurable, or environment-specific; keep fixed endpoint data literal.
  - **Response contract:** add each known success and relevant error status to `responses`, with status code, description, and content type. Include schema and example payload when known. Use an empty `content` list for a response with no body.
  - **Documentation:** use `documentation` for purpose, behavior, validation rules, side effects, and integration notes that are not clear from the fields above.
- Use Global variables for workspace-wide defaults and environment variables for values that differ across Development, Staging, or Production. An active environment overrides a Global variable with the same name. Keep variable names descriptive and consistent, such as `baseUrl`, `apiPrefix`, `accessToken`, and `tenantId`.
- For bearer tokens, API keys, passwords, and other credentials, put a reference such as `{{accessToken}}` in the request only when required; never put the real secret in a request, example, or documentation. Tell the user to mark the corresponding variable as **Secret** in the desktop Variables UI so its value stays on-device and out of commits/cloud sync.
- The MCP server can add variable references to request fields, but it cannot list, create, or edit variable definitions or values. Do not claim a referenced variable exists or invent its value. If it cannot be verified, call out the variable the user needs to define in Variables and include that gap in the preview summary.
- Before documenting, inspect available project source, OpenAPI specs, or existing examples to resolve missing facts. Ask the user for any integration-critical details that cannot be verified, especially route, auth, body shape, or response contract. Do not invent parameters, headers, schemas, status codes, or example values.
- If the user explicitly requests a draft while details are unknown, document only verified facts, identify each gap in `documentation` and the preview summary, and do not present the draft as complete. For response details the user or source provides, record the status code, description, content type, schema, and example payload in `responses`.
- Check completeness before previewing every create or edit. If a field does not apply, leave it empty or mark the body as `none`; do not add placeholder rows just to fill the checklist.
- Use `preview_changes` for every create, edit, move, rename, deprecation, or delete. A tool call or hidden tool result is not a user-visible preview.
- After `preview_changes`, show a readable, diff-style preview directly in chat before applying anything. Include the workspace and full collection path, then each action and target. For request creation, show method, URL, params, headers, auth type, body mode/content type and body, response statuses/content types/schemas/examples, and documentation. For edits, show each changed field as before → after. For moves and renames, show old → new path/name. For deletion, name the exact item and, for folders, count all nested items that will be removed. Show unresolved variable references that the user must define. Redact all secret values; never paste raw tool JSON as the only preview.
- End the preview message by asking the user to approve these exact changes, then stop and wait. A request to make a change is not approval of its preview. Call `apply_changes` only after the user explicitly approves the displayed preview. For deletion, require a clear request to delete and set `confirmDelete: true` only after confirmation.
- Never copy a redacted credential back into a request. Preserve existing auth settings and variable references unless the user asks to change them; MCP must not read or change actual environment variable values.
- Mark deprecated endpoints with `deprecate_request`, include the user's reason when provided, and mention a replacement endpoint when one is known.
- Leave commit and push to the user unless they explicitly ask to perform them.

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The product has an Electron desktop interface and a browser portal. Both interfaces are in scope for the current redesign.

## Users

Developers who compose and test API requests, and teams who read API documentation and collaborate on workspaces. The user confirmed that both groups are equally important.

## Product Purpose

The desktop app supports editing local API collections, sending requests, documenting endpoints, and syncing workspace commits. The browser portal lets members read shared API contracts and manage workspace access.

## Operating Context

Desktop users work with collections, request parameters and bodies, response contracts, environment variables, OpenAPI import and export, and local drafts. Cloud members browse shared workspaces, API docs, activity, and team access. Changes are committed and pushed from desktop, then pulled by collaborators.

## Capabilities and Constraints

- Preserve existing product behavior, saved data, and familiar workflows across both interfaces during redesign. The user explicitly prioritized keeping the workflow.
- The desktop interface uses Electron, React, TypeScript, and Vite. The portal uses React, TypeScript, and Vite.
- The portal has owner, editor, and viewer roles. Owners can invite members.
- Sync is commit based. Live editing and branches are not supported.
- The documentation surface includes endpoint navigation, descriptions, structured response contracts, and examples.

## Brand Commitments

The current product name shown in the interfaces is API Documentation. No additional brand requirements were confirmed.

## Evidence on Hand

Existing source code and repository documentation describe the implemented workflows. There are no supplied customer claims, testimonials, or external brand assets to use in the redesign.

## Product Principles

- Keep the request workflow direct and inspectable.
- Make shared API contracts easy to find and understand.
- Show sync and workspace state clearly where decisions depend on it.
- Keep desktop and cloud recognizable as one product while respecting their different tasks.

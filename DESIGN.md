# Design Direction

## Identity

An API workspace for developers who write, inspect, and verify requests, and for teammates who read shared contracts, without leaving their documentation context. Desktop and the cloud portal read as one product while serving their different tasks.

## Visual language

A single graphite console, dark first. A deep graphite ground carries the work; panels are separated by fine seams rather than shadows or cards that float. Text is cool and high-contrast. One blue accent marks the current action, selection, and keyboard focus. Green, amber, and red appear only when they carry meaning: response status, request method, and sync change state. Radii stay small so controls read as controls, and there are no decorative gradients.

## Typography

Use a compact system sans (`system-ui`) for interface text, because a developer console reads as native tooling and stays dense without a webfont load. Use the native monospace stack for URLs, request/response headers, response bodies, and code, where character alignment carries meaning. Blue monospace marks API field names in contract tables.

Size floor: functional UI text (buttons, nav, labels, table cells, meta rows, method and status chips) is at least 11px; body text is at least 12px. Metadata sits at 11–12px, body and controls at 13–14px, section headings at 16–17px, and page headings scale with the viewport up to roughly 25–32px.

## Layout and motion

Dial: ENERGY 2 / RHYTHM 2 / MOTION 1.

Desktop keeps the collection rail, a prominent request editor, and a simultaneous response panel as the signature paired working field. Cloud keeps its workspace rail and page header; documentation places a clear endpoint index beside the reading pane. The current location and the relevant sync or response status stay visible. Panels change state without decorative animation. Both interfaces reflow to a single column at narrow widths, and the auth screen collapses its brand panel on small viewports.

## Color tokens (graphite)

- Ground `#0e151d`, rail `#0a1118` / `#090f16`, panel `#151e28`, raised `#1c2936`, input `#101923`.
- Seams: line `#354556`, line-soft `#293846`.
- Text `#e9f0f7`, muted `#a8b8c8`.
- Accent blue `#80bdff`; status green `#8cdbad`, red `#ff9fa8`, amber `#f1c977`.

## Decision reasons

- Graphite dark-first: reads as developer tooling and avoids the generic blue-on-white dashboard while keeping familiar navigation and controls.
- One blue accent: identifies the send action, active item, and focus ring without coloring every surface.
- Status-only color: green, amber, and red stay meaningful because they are reserved for method, response, and change state.
- Fine seams over cards: keep a dense technical layout legible without decorative elevation.
- Split request/response workspace: keeps input and inspection visible in one task flow.
- System sans over a webfont: native, compact, and fast for a tool used repeatedly; monospace carries API material where alignment matters.
- 11px functional / 12px body floor: keeps dense metadata legible on high-DPI and small viewports.
- No illustration: the product interface itself is the relevant visual evidence.

## Implementation

The graphite direction ships as a theme layer: each app loads its base `styles.css` and then `graphite.css`, which redefines tokens and surfaces. Desktop UI primitives (`button`, `input`, `select`, `tabs`, `textarea`) carry `graphite-*` classes; both apps' semantic classes are themed directly in `graphite.css`.

# Repository Guidelines

## Project Structure & Module Organization

This working tree is currently empty apart from this guide; no source, documentation, tests, or asset directories are present yet. Keep API documentation organized by service or API area as the repository grows (for example, `docs/<service>/`), and place reusable examples or schemas in clearly named subdirectories such as `examples/` or `schemas/`. Keep the top-level README focused on setup and navigation.

## Build, Test, and Development Commands

No build or test configuration is currently checked in, so there are no repository-specific commands to run. When adding a documentation toolchain, record its install, preview, validation, and test commands in the README and keep them reproducible from the repository root. Validate generated or edited API references with the chosen formatter or schema checker before submitting changes.

## Coding Style & Naming Conventions

Use Markdown for prose, with descriptive sentence-case headings and short paragraphs. Use fenced code blocks with a language tag for request and response examples. Use consistent paths and filenames in lowercase kebab-case (for example, `authentication.md`); name schema files after the API resource or operation they describe. Keep examples accurate, minimal, and free of real credentials or personal data.

## Testing Guidelines

There is no test framework or test suite in the current tree. For documentation-only changes, check links, code fences, and rendered formatting. For API schemas or examples added later, include the repository's selected validation command and cover valid and invalid cases where practical.

## Commit & Pull Request Guidelines

No Git history is available in this working tree, so an established commit convention cannot be determined. Use concise imperative commit subjects (for example, `Document token refresh endpoint`). Pull requests should summarize the API or pages changed, explain any compatibility or behavioral impact, link related issues when available, and include rendered screenshots only when layout or presentation changes need visual review.

## Security & Configuration

Never commit API keys, access tokens, private customer data, or production-only configuration. Use clearly fake example values and mark placeholders (for example, `YOUR_API_TOKEN`).

<!-- antislop:start -->
## Antislop UI Guidelines

For interface work, read `.agents/skills/antislop/antislop.md` and the relevant local skill:
- UI and visual design: `.agents/skills/antislop/skills/antislop-ui/SKILL.md`
- Accessibility and interaction: `.agents/skills/antislop/skills/antislop-human/SKILL.md`
- Responsive layout: `.agents/skills/antislop/skills/antislop-layoutmobile/SKILL.md`

Resolve the mode using the core's `Two Usage Modes` rules before UI work. Explicit session choices take priority; otherwise use the saved preference or ask. Follow the existing `DESIGN.md` direction and run the core Delivery Gate before handing off UI work. The accessibility skill includes its required `contrast-check.py` helper.
<!-- antislop:end -->

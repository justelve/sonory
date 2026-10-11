# Contributing to Sonory

## Tooling

Use mise to install the versions in `mise.toml` with `mise trust` and `mise install`.
Without mise, install Node.js **24.20.0** and pnpm **12.11.2** directly.
Other development tools are installed by `pnpm install`.

## Development

Build dependencies before typed linting when packages consume their emitted declarations.

## Workspace conventions

- Use `@sonory/*` names, `workspace:*` dependencies, and `private: true` for unpublished packages.
- Colocate package tests with the source they cover, and exclude them from emitted builds.

## Commit messages

Write titles in the present tense. Use specific verbs instead of generic words
such as "add", "fix", or "implement".

The body is optional. Wrap it at 80 characters and include only information that
cannot be inferred from code alone, such as decisions, tradeoffs, implicit
constraints, or research findings.

Prefer "Pin CI actions to release commits" over "Fix CI", or "Reject unresolved
side-effect imports" over "Add TypeScript checks".

A body can explain why a choice was made:

```text
Keep download concurrency configurable

Provider rate limits vary by account and may change without notice. A fixed
limit would force a release whenever those limits change.
```

## Contribution licensing

Sonory is licensed under the [MIT license](./LICENSE). By submitting a contribution,
you agree to license that contribution under the same MIT license. Contributors
retain copyright in their contributions; contributing does not assign copyright
to the project or its maintainers.

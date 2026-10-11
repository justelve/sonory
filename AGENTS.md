# Working on Sonory

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before making changes. Use repository
configuration as the source of truth for tooling and commands.

## Changes

- Prefer the smallest implementation that meets the current requirement. Add
  dependencies and abstractions only when existing tools cannot do the job simply.
- Document only decisions and constraints that cannot be inferred easily from code.
- Run checks appropriate to the change. Use `pnpm check` for code or tooling changes;
  formatting and link checks are enough for documentation-only changes.

# Working on Sonory

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before making changes. Use repository
configuration as the source of truth for tooling and commands.

## Changes

- Prefer the smallest implementation that meets the current requirement. Add
  dependencies and abstractions only when existing tools cannot do the job simply.
- Document only decisions and constraints that cannot be inferred easily from code.
- Use neverthrow `Result` and `ResultAsync` for fallible operations. Return tagged
  domain errors instead of throwing; keep raw values only for infallible operations.
- Use Zod for schema validation and convert validation failures into error results.
- Run checks appropriate to the change. Use `pnpm check` for code or tooling changes;
  formatting and link checks are enough for documentation-only changes.

# Sonory

Extensible provider-neutral music workbench.

## Try the CLI

```sh
pnpm install
pnpm build
pnpm sonory --help
```

Downloads require an existing output directory and preserve existing files.
Use Ctrl+C to cancel. Publishing uses a hard link, so the output filesystem
must support hard links. Failed or cancelled downloads remove their temporary file;
cleanup failures return an error.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

Sonory is licensed under the [MIT license](./LICENSE).

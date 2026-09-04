# Agent-first Nix environment

The root `flake.nix` and committed `flake.lock` define the reproducible
development shell for this repository. The shell pins Node.js 22 and includes
`just`, `sops`, `age`, `ores-sops`, Python, Git, direnv, and ShellCheck. It does
not contain publishing credentials or platform login state.

Enter the shell with `nix develop`, or run the complete non-interactive baseline
directly:

```sh
nix flake check --no-update-lock-file
nix develop --no-update-lock-file -c agent-check
```

`agent-check` verifies the tracked secret boundary and encrypted-environment
shape, installs exactly `package-lock.json` without lifecycle scripts, then runs
the TypeScript check, build, and security-focused test suite. It never decrypts
an environment or activates YouTube credentials.

The AI server calls hosted model and publishing APIs and does not render media
locally, so Docker, a browser, FFmpeg, and provider CLIs are intentionally not
part of the development shell. The repository Dockerfile remains the production
container boundary. See `../env/README.md` for explicit secret activation.

The implementation stays in `.nix/flake.nix`; the root flake delegates to it so
standard Nix tooling, CI, and repository scanners all use the same outputs.

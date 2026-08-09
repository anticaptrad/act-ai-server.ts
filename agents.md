# act-ai-server agent instructions

## Repository restrictions and publishing invariants

- Do not run `git reset`, `git filter-repo`, or `git clean`.
- Do not run `rm` except when explicitly deleting known temporary or scratch files.
- `dotenv` is blacklisted. Do not install or use it; configuration comes from the process environment or runtime secret manager.
- Protect every `/api/*` operation with `SERVER_AUTH_SECRET` and fail closed when required publishing credentials are absent or invalid.
- YouTube authorization uses a Desktop OAuth client and loopback redirect. Authorization codes and refresh tokens must never leave the initiating machine through logs, URLs beyond the loopback flow, shell arguments, telemetry, or Git.
- Verify that credentials own the configured channel before installation or upload. Never silently publish through credentials for a different channel.
- Resolve upload paths inside the approved render directory, reject traversal, absolute escape, and outward-pointing symlinks, and default uploads to private visibility.
- Preserve bounded provider errors, quota handling, explicit channel pins, and operator-visible readiness without revealing secrets.

## Instruction discovery

Resolve `$PWD`, walk upward through every parent directory to the filesystem root, read every readable lowercase `agents.md` on that ancestor chain, and apply them root-to-leaf. Do not search siblings. Deduplicate resolved paths/inodes, avoid symlink cycles, and report unreadable files.

## Synchronize with the remote

Before editing, inspect `git status`, current branch, remotes, and default branch. Run `git fetch --all --prune` and create the feature branch from the latest remote default branch. Fetch again before pushing and incorporate upstream changes using repository merge policy.

- avoid git rebase in favor of git merge.
- Never discard remote commits, force-push, rewrite shared history, bypass review, or bypass required CI.

## Resolve Git conflicts semantically

Resolve conflicts by understanding and combining both sides' intent. Do not mechanically choose `ours`, `theirs`, current, or incoming changes. Produce the conceptually correct result while preserving compatible authentication, OAuth flow, token secrecy, channel ownership verification, upload-directory confinement, private defaults, provider/quota behavior, tests, documentation, configuration, and publishing behavior. If intentions are incompatible, make the smallest explicit design decision and document it in the pull request.

After resolving, reread every affected file from the top, run formatting, linting, tests, builds, authorization/publishing safety tests, and security validation, then search the entire worktree for conflict markers:

```sh
grep -RInE '^(<<<<<<<|=======|>>>>>>>)' --exclude-dir=.git .
```

If any marker or suspicious partial resolution remains, repeat semantic resolution from the top and rerun validation. A conflict is resolved only when the result is conceptually coherent and verified, not merely accepted by Git.

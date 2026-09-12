# Security policy

## Reporting a vulnerability

Do not open a public issue containing a live API key, OAuth authorization code, refresh token, server-auth secret, channel credential, private render path, or other credential material. Use GitHub's private vulnerability-reporting/security-advisory flow for this repository when available, or contact the repository maintainers through a private organization channel.

A useful report identifies the affected commit and code path, expected security boundary, reproduction steps using synthetic credentials/data, and impact. Redact secrets from logs and screenshots before attaching them.

## Security invariants

Changes to this service must preserve these fail-closed properties:

- every `/api/*` route requires `SERVER_AUTH_SECRET`; an unconfigured secret closes protected routes rather than opening them;
- LLM and YouTube credentials are supplied by the runtime environment/secret manager, never `.env`/`dotenv`, source control, command-line arguments, or telemetry;
- OAuth authorization codes and YouTube refresh tokens never leave the initiating/managed credential path through logs, URLs beyond the approved loopback flow, or issue/PR content;
- YouTube credentials are checked against the configured expected channel before publication;
- caller-provided upload paths resolve to regular supported video files inside the approved render root, including after symlink resolution;
- upload visibility defaults to `private`, and wider visibility requires deliberate reviewed configuration;
- provider errors and readiness reporting remain bounded and must not echo secret values;
- GitHub Actions use least-privilege permissions, immutable action pins, and non-persisted checkout credentials.

Security fixes must add or preserve regression coverage for the affected boundary. Do not suppress a failing security check merely to make CI green.
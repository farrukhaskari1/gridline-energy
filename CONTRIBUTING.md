# Contributing

Thank you for helping improve Gridline Energy.

## Before opening a pull request

1. Create a focused branch and keep unrelated changes separate.
2. Do not include credentials, environment files, household data, station coordinates, device serial numbers, database exports, screenshots containing private data, or deployment IDs.
3. Run `npm run lint` and `npm test`.
4. Explain the user-visible behavior, security implications, and test coverage in the pull request.

Use synthetic fixtures in tests and documentation. Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Code style

- Keep provider-specific behavior in `lib/itel.ts` and normalize it before exposing it to the UI.
- Keep credentials server-side and avoid logging upstream payloads that may contain household or device information.
- Preserve explicit stale/offline states; never make an old reading appear current.
- Add tests for data normalization, sign conventions, time windows, authentication boundaries, and failure behavior.

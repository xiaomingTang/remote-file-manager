# AGENTS.md

## Project Overview

`remote-file-manager` is a TypeScript VS Code extension for browsing, editing, transferring, and searching files in Docker containers or SSH hosts without installing a remote VS Code server.

The extension targets VS Code `^1.90.0` and uses Node.js `v24.19.0` as specified by `.nvmrc`.

## Repository Layout

```text
src/
|-- extension.ts       // Extension activation, command registration, tree view wiring, and VS Code integration.
|-- config.ts          // Connection settings, definitions, and connection management.
|-- constants.ts       // Shared extension constants.
|-- types.ts           // Shared connection, remote node, file, and connector types.
|-- utils.ts           // Path, tree command, clipboard, and other shared helpers.
|-- loading.ts         // Loading-state helpers for remote operations.
|-- connectors/
|   |-- docker.ts      // Docker connector implementation.
|   |-- factory.ts     // Connector factory abstractions.
|   |-- ssh-cli.ts     // SSH command-line argument and shell helpers.
|   `-- ssh.ts         // SSH connector implementation.
|-- providers/
|   |-- fs.ts          // `remote-file-manager://` virtual file system provider.
|   `-- tree.ts        // Remote file tree provider and drag-and-drop support.
|-- services/
|   |-- download.ts         // Remote download operations.
|   |-- file-operations.ts  // Remote file and directory operations.
|   |-- info.ts             // Remote item information panel.
|   |-- search.ts           // Remote file search panel and operations.
|   |-- terminal.ts         // Remote terminal creation.
|   |-- transfer.ts         // Cross-connection transfer operations.
|   `-- trash.ts            // Remote trash and cleanup handling.
|-- error/
|   |-- custom-error.ts     // User-facing custom error types.
|   `-- message.ts          // User-facing error messages.
`-- types/
	`-- ejs.d.ts            // Type declarations for EJS templates.

test/
`-- connection-config.test.js // Node built-in tests for compiled extension modules.

static/                    // Packaged static assets.
images/                    // Extension and documentation images.
dist/                      // Generated TypeScript and bundled output; do not edit manually.
```

## Development Setup

1. Use Node.js `v24.19.0`, for example with `nvm use`.
2. Install dependencies with `npm ci`.
3. Run `npm run check` for a TypeScript check without emitting files.
4. Run `npm run compile` to clean and rebuild `dist/` and the bundled extension.

The repository uses strict TypeScript, Node16 module resolution, ES2022 output, and Prettier with `prettier-plugin-ejs`.

## Testing and Validation

The test file imports compiled modules, so compile before running tests:

```sh
npm run compile
node --test test/connection-config.test.js
```

Before submitting a change, run at least:

```sh
npm run check
npm run compile
node --test test/connection-config.test.js
```

For extension behavior, launch the extension in the VS Code Extension Development Host and verify the affected command or view manually. The extension package can be built with `npm run package` when packaging behavior is relevant.

## Implementation Guidelines

- Keep public types and the `IRemoteConnector` abstraction consistent across Docker and SSH connectors.
- Keep remote paths distinct from local paths and use the existing path utilities when constructing virtual URIs or command arguments.
- Read `vscode.workspace.getConfiguration()` at access time when handling connection settings so changes are not hidden by a stale cached configuration object.
- Docker operations use the Docker connector; SSH file operations and terminals use the system `ssh` and `scp` commands. This allows the user's `~/.ssh/config`, default keys, and SSH agent to apply naturally.
- SSH file operations use `BatchMode=yes` and do not prompt for passwords.
- When passing a remote script through OpenSSH, preserve the existing `sh -lc` quoting approach. OpenSSH joins remote arguments with spaces before invoking the login shell.
- Preserve read-only behavior for connections, directories, and files across commands, menus, drag-and-drop, and file operations.
- Prefer existing helpers and connector methods over duplicating path or shell handling.
- Keep user-facing errors actionable and avoid exposing unnecessary command details or credentials.

## Change Scope

- Make focused changes in `src/` and add or update a nearby test in `test/` for behavior changes.
- Do not commit generated `dist/` output, `.vsix` files, logs, or `node_modules/`; these are ignored or generated artifacts.
- Preserve unrelated working-tree changes. Do not use destructive Git commands such as `git reset --hard` or `git checkout --` to clean the workspace.
- Update `README.md` when a user-visible command, configuration format, setup step, or release workflow changes.

## Release

Create a tag whose version matches `package.json`, such as `v0.1.2`. GitHub Actions packages the extension, publishes the VSIX to the Visual Studio Marketplace, and attaches it to a GitHub Release. Publishing requires the repository secret `VSCE_PAT`.

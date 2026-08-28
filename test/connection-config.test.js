const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

let configurationValue;
let configurationGetCount = 0;
let workspaceGetConfigurationCount = 0;
const configurationChangeListeners = new Set();
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (
    request === "./search.ejs" &&
    parent?.filename?.endsWith("/dist/services/search.js")
  ) {
    return "";
  }

  if (request === "ejs") {
    return { render: () => "" };
  }

  if (request === "vscode") {
    class MockEventEmitter {
      constructor() {
        this.listeners = new Set();
      }
      event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(value) {
        for (const listener of this.listeners) {
          listener(value);
        }
      }
    }

    const FileChangeType = {
      Changed: 1,
      Created: 2,
      Deleted: 3,
    };

    const FileSystemError = class extends Error {
      static FileNotFound(uri) {
        const error = new Error(`File not found: ${uri.toString()}`);
        error.code = "FileNotFound";
        return error;
      }
      static Unavailable(uri) {
        const error = new Error(`Unavailable: ${uri.toString()}`);
        error.code = "Unavailable";
        return error;
      }
    };

    const Uri = {
      from: (value) => ({
        ...value,
        toString: () => `${value.scheme}://${value.authority}${value.path}`,
      }),
    };

    return {
      workspace: {
        getConfiguration: () => {
          workspaceGetConfigurationCount += 1;
          return {
            get: () => {
              configurationGetCount += 1;
              return configurationValue;
            },
            update: async () => undefined,
          };
        },
        onDidChangeConfiguration: (listener) => {
          configurationChangeListeners.add(listener);
          return {
            dispose: () => configurationChangeListeners.delete(listener),
          };
        },
      },
      window: {
        showErrorMessage: () => undefined,
      },
      ConfigurationTarget: { Global: 1 },
      EventEmitter: MockEventEmitter,
      FileChangeType,
      FileSystemError,
      FileType: { File: 1, Directory: 2 },
      Uri,
      ViewColumn: { Active: 1 },
      Disposable: class {},
      Position: class {
        constructor(line, character) {
          this.line = line;
          this.character = character;
        }
      },
      Location: class {
        constructor(uri, position) {
          this.uri = uri;
          this.range = { start: position, end: position };
        }
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const { DockerConnectorFactory } = require("../dist/connectors/docker.js");
const { SSHConnectorFactory } = require("../dist/connectors/ssh.js");
const { WSLConnectorFactory } = require("../dist/connectors/wsl.js");
const {
  scpConnectionArgs,
  sshConnectionArgs,
  sshDestination,
  interactiveLoginShellCommand,
  quoteShellArgument,
  remoteLoginShellArgs,
} = require("../dist/connectors/ssh-cli.js");
const { ConnectionManager } = require("../dist/config.js");
const {
  RemoteFileManagerFileSystemProvider,
} = require("../dist/providers/fs.js");
const { copyPathAcrossConnections } = require("../dist/services/transfer.js");
const { search } = require("../dist/services/search.js");
const { TrashManager } = require("../dist/services/trash.js");
const {
  canDropIntoTarget,
  formatItemNames,
  formatItemNameSummary,
  resolveDropTargetPath,
  resolvePasteTargetPath,
  resolveTrashPath,
  resolveTreeCommandNode,
  resolveTreeCommandNodes,
  shouldCleanupTrash,
  buildFindNameExpression,
  withItemNames,
} = require("../dist/utils.js");
const extensionPackage = require("../package.json");

test("connector factories resolve their connection definitions", () => {
  const document = {
    connections: {
      docker: [{ id: "docker-1", container: "api", path: "/srv/app" }],
      ssh: [
        {
          id: "ssh-1",
          host: "example.com",
          username: "deploy",
          path: "/home/deploy",
        },
      ],
      wsl: [
        {
          id: "wsl-1",
          distribution: "Ubuntu-22.04",
          path: "/home/user/project",
        },
      ],
    },
  };

  assert.deepEqual(DockerConnectorFactory.resolveDefinitions(document), [
    { id: "docker-1", container: "api", path: "/srv/app" },
  ]);
  assert.deepEqual(SSHConnectorFactory.resolveDefinitions(document), [
    {
      id: "ssh-1",
      host: "example.com",
      username: "deploy",
      path: "/home/deploy",
    },
  ]);
  assert.deepEqual(WSLConnectorFactory.resolveDefinitions(document), [
    {
      id: "wsl-1",
      distribution: "Ubuntu-22.04",
      path: "/home/user/project",
    },
  ]);
});

test("ssh CLI helpers omit optional flags so OpenSSH can use ~/.ssh/config", () => {
  const definition = {
    id: "ssh-1",
    host: "staging",
    username: "deploy",
    path: "/home/deploy",
  };

  assert.equal(sshDestination(definition), "deploy@staging");
  assert.deepEqual(sshConnectionArgs(definition), []);
  assert.deepEqual(sshConnectionArgs(definition, { batchMode: true }), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
  ]);
  assert.deepEqual(scpConnectionArgs(definition), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
  ]);
});

test("interactive terminals use the login shell so prompts and colors load", () => {
  assert.equal(
    interactiveLoginShellCommand("/var/app"),
    `cd '/var/app' && export TERM="\${TERM:-xterm-256color}" && exec "\${SHELL:-/bin/bash}" -il`,
  );
  assert.match(interactiveLoginShellCommand("/tmp/o's"), /cd '\/tmp\/o'\\''s'/);
});

test("ssh remote commands quote the script so OpenSSH keeps it as one -lc argument", () => {
  const script = `for entry in ${quoteShellArgument("/")}/*; do echo "$entry"; done`;
  const args = remoteLoginShellArgs(script);

  assert.deepEqual(args.slice(0, 2), ["sh", "-lc"]);
  assert.equal(args[2], quoteShellArgument(script));
  assert.match(args.join(" "), /^sh -lc '/);
  assert.doesNotMatch(args.join(" "), /sh -lc for /);
});

test("name search supports literal and anchored ^ and $ matches", () => {
  assert.equal(buildFindNameExpression("config"), "\\( -iname '*config*' \\)");
  assert.equal(
    buildFindNameExpression("^config"),
    "\\( -iname '*^config*' -o -iname 'config*' \\)",
  );
  assert.equal(
    buildFindNameExpression("config$"),
    "\\( -iname '*config$*' -o -iname '*config' \\)",
  );
  assert.equal(
    buildFindNameExpression("^config$"),
    "\\( -iname '*^config$*' -o -iname 'config' \\)",
  );
  assert.equal(buildFindNameExpression("^"), "\\( -iname '*^*' \\)");
  assert.equal(buildFindNameExpression("$"), "\\( -iname '*$*' \\)");
});

test("connector factories default to empty definitions when settings are absent", () => {
  assert.deepEqual(DockerConnectorFactory.resolveDefinitions(undefined), []);
  assert.deepEqual(SSHConnectorFactory.resolveDefinitions(undefined), []);
});

test("remote file deletions fire a deleted change event for open editors", async () => {
  const deletedPaths = [];
  const connectionManager = {
    validateConnection: async () => true,
    getConnector: () => ({
      deletePath: async (remotePath) => {
        deletedPaths.push(remotePath);
      },
    }),
  };
  const provider = new RemoteFileManagerFileSystemProvider(connectionManager);
  let changedEvents = [];
  const subscription = provider.onDidChangeFile((events) => {
    changedEvents = events;
  });

  const uri = {
    scheme: "remote-file-manager",
    authority: "ssh-1",
    path: "/workspace/a.txt",
    toString: () => "remote-file-manager://ssh-1/workspace/a.txt",
  };
  await provider.delete(uri, { recursive: false });

  assert.deepEqual(deletedPaths, ["/workspace/a.txt"]);
  assert.equal(changedEvents[0].type, 3);
  assert.equal(changedEvents[0].uri.toString(), uri.toString());
  subscription.dispose();
});

test("trash paths isolate same-named files in timestamp directories", () => {
  assert.equal(
    resolveTrashPath("/a/a.txt", 1000),
    "/tmp/remote-file-manager-trash/1000/a.txt",
  );
  assert.equal(
    resolveTrashPath("/b/a.txt", 1001),
    "/tmp/remote-file-manager-trash/1001/a.txt",
  );
});

test("trash cleanup requires more than one minute between deletes", () => {
  assert.equal(shouldCleanupTrash(undefined, 100_000), false);
  assert.equal(shouldCleanupTrash(100_000, 180_000), false);
  assert.equal(shouldCleanupTrash(100_000, 280_001), true);
});

test("trash manager cleans up old trash roots before a later delete batch", async () => {
  const deleteCalls = [];
  const moveCalls = [];
  const connectors = {
    c1: {
      movePath: async (sourcePath, targetPath) => {
        moveCalls.push(["c1", sourcePath, targetPath]);
      },
      deletePath: async (remotePath) => {
        deleteCalls.push(["c1", remotePath]);
      },
    },
    c2: {
      movePath: async (sourcePath, targetPath) => {
        moveCalls.push(["c2", sourcePath, targetPath]);
      },
      deletePath: async (remotePath) => {
        deleteCalls.push(["c2", remotePath]);
      },
    },
  };
  const manager = new TrashManager();
  const originalNow = Date.now;

  try {
    Date.now = () => 100_000;
    const firstBatch = await manager.moveItemsToTrash(
      [
        {
          connectionId: "c1",
          label: "a.txt",
          path: "/a/a.txt",
          type: "file",
        },
      ],
      async (node) => connectors[node.connectionId],
    );

    Date.now = () => 280_001;
    const secondBatch = await manager.moveItemsToTrash(
      [
        {
          connectionId: "c2",
          label: "b.txt",
          path: "/b/b.txt",
          type: "file",
        },
      ],
      async (node) => connectors[node.connectionId],
    );

    assert.equal(
      firstBatch[0].trashPath,
      "/tmp/remote-file-manager-trash/100000/a.txt",
    );
    assert.equal(
      secondBatch[0].trashPath,
      "/tmp/remote-file-manager-trash/280001/b.txt",
    );
    assert.deepEqual(deleteCalls, [["c1", "/tmp/remote-file-manager-trash"]]);
    assert.deepEqual(moveCalls, [
      ["c1", "/a/a.txt", "/tmp/remote-file-manager-trash/100000/a.txt"],
      ["c2", "/b/b.txt", "/tmp/remote-file-manager-trash/280001/b.txt"],
    ]);
  } finally {
    Date.now = originalNow;
  }
});

test("connection validation reads configuration once", async () => {
  const definition = { id: "docker-1", container: "api", path: "/srv/app" };
  configurationValue = {
    connections: {
      docker: [definition],
      ssh: [],
    },
  };
  configurationGetCount = 0;
  workspaceGetConfigurationCount = 0;

  const manager = new ConnectionManager();
  const connector = manager.getConnector("docker-1");
  assert.ok(connector);
  connector.listDir = async () => [];

  assert.equal(await manager.validateConnection("docker-1"), true);
  assert.equal(workspaceGetConfigurationCount, 1);
  assert.equal(configurationGetCount, 1);
  manager.dispose();
});

test("cached configuration document refreshes when settings change", () => {
  configurationValue = { connections: { docker: [], ssh: [] } };
  configurationGetCount = 0;
  workspaceGetConfigurationCount = 0;

  const manager = new ConnectionManager();
  assert.deepEqual(manager.getDefinitions(), []);

  configurationValue = {
    connections: {
      docker: [{ id: "docker-2", container: "worker", path: "/app" }],
      ssh: [],
    },
  };
  for (const listener of configurationChangeListeners) {
    listener({
      affectsConfiguration: (key) => key === "remoteFileManager.connections",
    });
  }

  assert.deepEqual(manager.getDefinitions(), [
    { id: "docker-2", container: "worker", path: "/app" },
  ]);
  assert.equal(workspaceGetConfigurationCount, 2);
  assert.equal(configurationGetCount, 2);
  manager.dispose();
});

test("search ranks an exact filename above a filename with an extra extension", async () => {
  const connectionManager = {
    getDefinition: () => ({ path: "/workspace" }),
    getConnectorOrThrow: () => ({
      searchFiles: async () => [
        { path: "/workspace/readme.md.gz", isDirectory: false },
        { path: "/workspace/readme.md", isDirectory: false },
      ],
    }),
  };

  const results = await search(connectionManager, {
    connectionId: "ssh-1",
    searchDirectory: "/workspace",
    searchValue: "readme.md",
    excludePatterns: [],
  });

  assert.deepEqual(
    results.map((result) => result.path),
    ["/workspace/readme.md", "/workspace/readme.md.gz"],
  );
});

test("resolveDropTargetPath keeps the dragged item name under the target directory", () => {
  assert.equal(
    resolveDropTargetPath("/workspace/app/config.json", "/workspace/app"),
    "/workspace/app/config.json",
  );
  assert.equal(
    resolveDropTargetPath("/workspace/app/config.json", "/workspace/app/other"),
    "/workspace/app/other/config.json",
  );
  assert.equal(
    resolveDropTargetPath("/workspace/app/feature", "/workspace/app/other"),
    "/workspace/app/other/feature",
  );
});

test("canDropIntoTarget allows file targets across connections", () => {
  assert.equal(canDropIntoTarget({ type: "directory" }), true);
  assert.equal(canDropIntoTarget({ type: "connection" }), true);
  assert.equal(canDropIntoTarget({ type: "file" }), true);
  assert.equal(canDropIntoTarget(undefined), true);
  assert.equal(
    canDropIntoTarget({ type: "directory", connectionId: "b" }, "a"),
    true,
  );
  assert.equal(
    canDropIntoTarget({ type: "file", connectionId: "b" }, "a"),
    true,
  );
  assert.equal(
    canDropIntoTarget({ type: "directory", connectionId: "a" }, "a"),
    true,
  );
});

test("copyPathAcrossConnections stages and recursively uploads directories", async () => {
  const uploaded = [];
  const createdDirectories = [];
  const sourceConnector = {
    async downloadPath(_remotePath, localPath) {
      await fs.mkdir(localPath);
      await fs.writeFile(path.join(localPath, "index.js"), "export {};");
    },
  };
  const destinationConnector = {
    async createDirectory(remotePath) {
      createdDirectories.push(remotePath);
    },
    async uploadFile(localPath, remotePath) {
      uploaded.push({
        remotePath,
        content: await fs.readFile(localPath, "utf8"),
      });
    },
  };

  await copyPathAcrossConnections(
    sourceConnector,
    destinationConnector,
    "/workspace/app",
    "/deploy/app",
  );

  assert.deepEqual(createdDirectories, ["/deploy/app"]);
  assert.deepEqual(uploaded, [
    { remotePath: "/deploy/app/index.js", content: "export {};" },
  ]);
});

test("resolvePasteTargetPath keeps the copied item name under the selected directory and root", () => {
  assert.equal(
    resolvePasteTargetPath("/workspace/app/config.json", "/workspace/app"),
    "/workspace/app/config.json",
  );
  assert.equal(
    resolvePasteTargetPath(
      "/workspace/app/config.json",
      "/workspace/app/other",
    ),
    "/workspace/app/other/config.json",
  );
  assert.equal(
    resolvePasteTargetPath("/workspace/app/feature", "/workspace/app/other"),
    "/workspace/app/other/feature",
  );
  assert.equal(
    resolvePasteTargetPath("/workspace/app/config.json", "/"),
    "/config.json",
  );
});

test("item name summaries show at most two names", () => {
  assert.equal(formatItemNames(["aaa.txt"]), "aaa.txt");
  assert.equal(formatItemNames(["aaa.txt", "bbb.md"]), "aaa.txt, bbb.md");
  assert.equal(
    formatItemNames(["aaa.txt", "bbb.md", "ccc.json"]),
    "aaa.txt, bbb.md...",
  );
  assert.equal(
    formatItemNameSummary([
      { label: "aaa.txt" },
      { path: "/workspace/bbb.md" },
      { label: "ccc.json" },
    ]),
    "aaa.txt, bbb.md...",
  );
  assert.equal(
    withItemNames("Copied 3 item(s)", [
      { label: "aaa.txt" },
      { label: "bbb.md" },
      { label: "ccc.json" },
    ]),
    "Copied 3 item(s): aaa.txt, bbb.md...",
  );
});

test("tree commands use the right-clicked node when it is not already selected", () => {
  const selected = {
    connectionId: "ssh-1",
    path: "/workspace/a.txt",
    type: "file",
  };
  const clicked = {
    connectionId: "ssh-1",
    path: "/workspace/b.txt",
    type: "file",
  };

  assert.deepEqual(resolveTreeCommandNodes(clicked, [selected]), [clicked]);
  assert.equal(resolveTreeCommandNode(clicked, [selected]), clicked);
});

test("tree commands keep the current selection when the right-clicked node is already selected", () => {
  const first = {
    connectionId: "ssh-1",
    path: "/workspace/a.txt",
    type: "file",
  };
  const second = {
    connectionId: "ssh-1",
    path: "/workspace/b.txt",
    type: "file",
  };

  assert.deepEqual(resolveTreeCommandNodes(second, [first, second]), [
    first,
    second,
  ]);
  assert.equal(resolveTreeCommandNode(second, [first, second]), second);
});

test("item context commands do not depend on the current selection context", () => {
  const itemMenus = extensionPackage.contributes.menus["view/item/context"];
  const itemCommands = [
    "remoteFileManager.createFile",
    "remoteFileManager.createFolder",
    "remoteFileManager.uploadFiles",
    "remoteFileManager.renameNode",
    "remoteFileManager.pasteNode",
  ];

  for (const command of itemCommands) {
    const menu = itemMenus.find((entry) => entry.command === command);
    const contributed = extensionPackage.contributes.commands.find(
      (entry) => entry.command === command,
    );
    assert.ok(menu, command);
    assert.doesNotMatch(menu.when, /remoteFileManager\.multiSelection/);
    assert.doesNotMatch(
      contributed.enablement ?? "",
      /remoteFileManager\.selected(Node|Directory)Readonly/,
    );
  }
});

test("paste menu disables when clipboard is empty", () => {
  const pasteCommand = extensionPackage.contributes.commands.find(
    (entry) => entry.command === "remoteFileManager.pasteNode",
  );

  assert.match(pasteCommand.enablement, /remoteFileManager.clipboardAvailable/);
});

test("connection root paste is not shown in the tree title", () => {
  const pasteRootMenu = extensionPackage.contributes.menus["view/title"].find(
    (entry) => entry.command === "remoteFileManager.pasteRoot",
  );
  const pasteRootCommand = extensionPackage.contributes.commands.find(
    (entry) => entry.command === "remoteFileManager.pasteRoot",
  );

  assert.equal(pasteRootMenu, undefined);
  assert.match(
    pasteRootCommand.enablement,
    /remoteFileManager.clipboardAvailable/,
  );
});

test("connection items support paste from the tree context menu", () => {
  const pasteMenu = extensionPackage.contributes.menus[
    "view/item/context"
  ].find((entry) => entry.command === "remoteFileManager.pasteNode");
  const pasteCommand = extensionPackage.contributes.commands.find(
    (entry) => entry.command === "remoteFileManager.pasteNode",
  );

  assert.match(pasteMenu.when, /viewItem == connection/);
  assert.match(pasteCommand.enablement, /remoteFileManager.clipboardAvailable/);
});

test("root paste has a keybinding", () => {
  const pasteRootKeybinding = extensionPackage.contributes.keybindings.find(
    (entry) => entry.command === "remoteFileManager.pasteRoot",
  );

  assert.ok(pasteRootKeybinding.key);
  assert.ok(pasteRootKeybinding.mac);
  assert.match(
    pasteRootKeybinding.when,
    /focusedView == remoteFileManagerView/,
  );
});

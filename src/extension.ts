import * as vscode from "vscode";
import { ConnectionManager, manageConnections } from "./config";
import {
  TO_EXPAND,
  RemoteTreeDataProvider,
  RemoteTreeDragAndDropController,
} from "./providers/tree";
import {
  RemoteDefinitionProvider,
  RemoteFileManagerFileSystemProvider,
} from "./providers/fs";
import { IRemoteConnector, RemoteNode } from "./types";
import {
  basename,
  decodeRemotePath,
  dirname,
  formatItemNameSummary,
  joinPath,
  normalizeRemotePath,
  resolveTreeCommandNode,
  resolveTreeCommandNodes,
  toVirtualUri,
  withItemNames,
} from "./utils";
import { downloadNodes } from "./services/download";
import { createRemoteTerminal } from "./services/terminal";
import { RemoteFileOperations } from "./services/file-operations";
import { TrashManager } from "./services/trash";
import { msg } from "./error/message";
import { CustomError } from "./error/custom-error";
import {
  DEFAULT_SEARCH_EXCLUDE_PATTERNS,
  SEARCH_EXCLUDE_PATTERNS_STATE_KEY,
  SEARCH_USE_DEFAULT_EXCLUDES_STATE_KEY,
  REMOTE_FILE_MANAGER_CONNECTIONS_CONFIG_KEY,
} from "./constants";
import { createInfoHtml, getInfoTitle } from "./services/info";
import { createSearchHtml, search, SearchOptions } from "./services/search";
import { DIFF_SCHEME, RemoteDiffManager } from "./services/diff";

type TreeClipboardAction = "cut" | "copy";

const INFO_PANEL_GROUP_RATIO = 0.3;
const SEARCH_PANEL_GROUP_RATIO = 0.4;
const TREE_FILE_DOUBLE_CLICK_INTERVAL_MS = 300;

interface TreeClipboardState {
  action: TreeClipboardAction;
  items: RemoteNode[];
}

async function showSameNameConflict(
  name: string,
  action: "paste" | "rename" | "upload",
): Promise<"overwrite" | "cancel" | "rename" | undefined> {
  const choice = await vscode.window.showWarningMessage(
    `An item named "${name}" already exists.`,
    { modal: true },
    "Overwrite",
    "Cancel",
    "Rename",
  );

  if (choice === "Cancel") {
    return "cancel";
  }

  if (choice === "Overwrite") {
    return "overwrite";
  }

  if (choice === "Rename") {
    return "rename";
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const connectionManager = new ConnectionManager();
  const treeProvider = new RemoteTreeDataProvider(connectionManager);
  const fileSystemProvider = new RemoteFileManagerFileSystemProvider(
    connectionManager,
  );
  const diffManager = new RemoteDiffManager(connectionManager);
  const fileOperations = new RemoteFileOperations(connectionManager);
  const trashManager = new TrashManager();
  let clipboardState: TreeClipboardState | undefined;
  let infoPanel: vscode.WebviewPanel | undefined;
  let infoRequestId = 0;
  let searchPanel: vscode.WebviewPanel | undefined;
  let lastOpenedFile:
    { connectionId: string; path: string; timestamp: number } | undefined;
  const getOutermostEditorColumn = (
    edge: "left" | "right",
  ): vscode.ViewColumn => {
    const columns = vscode.window.tabGroups.all.map(
      (group) => group.viewColumn,
    );
    return edge === "left" ? Math.min(...columns) : Math.max(...columns);
  };
  const resizeSearchPanel = async (): Promise<void> => {
    if (
      (searchPanel?.viewColumn ?? vscode.ViewColumn.One) <=
      vscode.ViewColumn.One
    ) {
      return;
    }

    await vscode.commands.executeCommand("vscode.setEditorLayout", {
      orientation: 0,
      groups: [
        { size: 1 - SEARCH_PANEL_GROUP_RATIO },
        { size: SEARCH_PANEL_GROUP_RATIO },
      ],
    });
  };
  const resizeInfoPanel = async (): Promise<void> => {
    await vscode.commands.executeCommand("vscode.setEditorLayout", {
      orientation: 0,
      groups: [
        { size: INFO_PANEL_GROUP_RATIO },
        { size: 1 - INFO_PANEL_GROUP_RATIO },
      ],
    });
  };
  const updateClipboardContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "remoteFileManager.clipboardAvailable",
      Boolean(clipboardState),
    );
  };
  const treeView = vscode.window.createTreeView("remoteFileManagerView", {
    treeDataProvider: treeProvider,
    canSelectMany: true,
    dragAndDropController: new RemoteTreeDragAndDropController(
      fileOperations,
      treeProvider,
      fileSystemProvider,
    ),
  });
  treeProvider.setTreeView(treeView);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remoteFileManager.manageConnections",
      async () => {
        await manageConnections();
        void treeProvider.refresh();
      },
    ),
  );
  updateClipboardContext();

  const updateSelectedNodeContext = (
    selection: readonly RemoteNode[] = [],
  ): void => {
    const node = selection[0];
    const selectedNodeType = node?.type ?? "none";
    void vscode.commands.executeCommand(
      "setContext",
      "remoteFileManager.selectedNodeType",
      selectedNodeType,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "remoteFileManager.multiSelection",
      selection.length > 1,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "remoteFileManager.selectedDirectoryReadonly",
      (node?.type === "directory" || node?.type === "connection") &&
        node.writable === false,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "remoteFileManager.selectedNodeReadonly",
      selection.some((item) => item.writable === false),
    );
  };

  const resolveConnectionRootTarget = async (): Promise<
    RemoteNode | undefined
  > => {
    const selected = treeView.selection[0];
    if (selected?.connectionId && selected.connectionId !== "__new__") {
      const definition = connectionManager.getDefinition(selected.connectionId);
      if (!definition) {
        return undefined;
      }

      return treeProvider.getDirectoryNode(
        selected.connectionId,
        definition.path ?? "/",
        selected,
      );
    }

    const definitions = connectionManager.getDefinitions();
    if (definitions.length !== 1) {
      return undefined;
    }

    const [definition] = definitions;
    return treeProvider.getDirectoryNode(definition.id, definition.path ?? "/");
  };

  const openRemoteTerminal = async (node?: RemoteNode): Promise<void> => {
    const target = resolveTreeCommandNode(node, treeView.selection);
    if (!target || !["connection", "directory", "file"].includes(target.type)) {
      return;
    }

    try {
      const definition = connectionManager.getDefinition(target.connectionId);
      if (!definition) {
        throw new Error(
          `Unknown connection type. connection id: ${target.connectionId}.`,
        );
      }

      const terminal = createRemoteTerminal(
        definition,
        target.type === "file" ? dirname(target.path) : target.path,
      );
      terminal.show();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to open remote terminal in ${target.path}: ${msg(error)}`,
      );
    }
  };

  const revealRemoteUri = async (uri: vscode.Uri): Promise<void> => {
    if (uri.scheme !== "remote-file-manager") {
      return;
    }

    const path = decodeRemotePath(uri);
    const parentPath = dirname(path);
    const parent = treeProvider.getDirectoryNode(uri.authority, parentPath);
    await treeProvider.revealNode(parent, TO_EXPAND);
    await treeProvider.selectNode(uri.authority, parentPath, path, parent);
  };

  const openSearch = async (node?: RemoteNode): Promise<void> => {
    const target = resolveTreeCommandNode(node, treeView.selection);
    const definitions = connectionManager.getDefinitions();
    const definition = target
      ? connectionManager.getDefinition(target.connectionId)
      : definitions.length === 1
        ? definitions[0]
        : undefined;
    if (!definition) {
      void vscode.window.showWarningMessage(
        "Select a connection or configure exactly one connection before searching.",
      );
      return;
    }

    const defaultSearchDirectory =
      target?.type === "directory" || target?.type === "connection"
        ? target.path
        : target?.type === "file"
          ? dirname(target.path)
          : definition.path;
    const connections = definitions.map((item) => ({
      id: item.id,
      path: item.path,
    }));
    const htmlOptions = {
      connections,
      defaultConnectionId: definition.id,
      defaultSearchDirectory,
      defaultValue: "",
      defaultMaxResults: Math.max(1, connectionManager.getMaxSearchFiles()),
      defaultExcludePatterns: context.globalState.get<string>(
        SEARCH_EXCLUDE_PATTERNS_STATE_KEY,
        "/mnt, /media",
      ),
      useDefaultExcludePatterns: context.globalState.get<boolean>(
        SEARCH_USE_DEFAULT_EXCLUDES_STATE_KEY,
        true,
      ),
    };

    if (!searchPanel) {
      const hasExistingTab = vscode.window.tabGroups.all.some(
        (group) => group.tabs.length > 0,
      );
      const reuseExistingGroup = vscode.window.tabGroups.all.length > 1;
      let searchColumn = reuseExistingGroup
        ? getOutermostEditorColumn("right")
        : vscode.ViewColumn.Beside;
      if (!hasExistingTab) {
        const anchorDocument = await vscode.workspace.openTextDocument({
          language: "plaintext",
          content: "",
        });
        await vscode.window.showTextDocument(anchorDocument, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: true,
          preview: true,
        });
        searchColumn = vscode.ViewColumn.Two;
      }

      searchPanel = vscode.window.createWebviewPanel(
        "remoteFileManager.search",
        "Search Files",
        searchColumn,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      if (!reuseExistingGroup) {
        await resizeSearchPanel();
      }
      searchPanel.webview.html = createSearchHtml(htmlOptions);
      searchPanel.webview.onDidReceiveMessage(async (message) => {
        if (message?.type === "copy-search-value") {
          if (typeof message.value !== "string") {
            return;
          }
          try {
            await vscode.env.clipboard.writeText(message.value);
            void vscode.window.showInformationMessage(
              `Copied "${message.value}" to clipboard.`,
            );
          } catch (error) {
            void vscode.window.showErrorMessage(
              `Unable to copy value: ${msg(error)}`,
            );
          }
          return;
        }

        if (message?.type === "open-search-settings") {
          await manageConnections();
          return;
        }

        if (message?.type === "connection-change") {
          const nextDefinition =
            typeof message.connectionId === "string"
              ? connectionManager.getDefinition(message.connectionId)
              : undefined;
          if (nextDefinition) {
            searchPanel?.webview.postMessage({
              type: "connection-default",
              searchDirectory: nextDefinition.path,
            });
          }
          return;
        }

        if (message?.type === "open") {
          if (
            typeof message.connectionId !== "string" ||
            typeof message.path !== "string"
          ) {
            return;
          }
          if (message.isDirectory === true) {
            const parentPath = dirname(message.path);
            await treeProvider.revealNode(
              treeProvider.getDirectoryNode(message.connectionId, parentPath),
              TO_EXPAND,
            );
            await treeProvider.selectNode(
              message.connectionId,
              parentPath,
              message.path,
            );
            return;
          }
          const parentPath = dirname(message.path);
          await treeProvider.revealNode(
            treeProvider.getDirectoryNode(message.connectionId, parentPath),
            TO_EXPAND,
          );
          await treeProvider.selectNode(
            message.connectionId,
            parentPath,
            message.path,
          );
          await vscode.commands.executeCommand(
            "vscode.open",
            toVirtualUri(message.connectionId, message.path),
            {
              preview: true,
              viewColumn:
                (searchPanel?.viewColumn ?? vscode.ViewColumn.Two) >
                vscode.ViewColumn.One
                  ? (searchPanel?.viewColumn ?? vscode.ViewColumn.Two) - 1
                  : vscode.ViewColumn.One,
            },
          );
          return;
        }

        if (message?.type !== "search" || !message.options) {
          return;
        }

        const options = message.options as SearchOptions;
        try {
          await context.globalState.update(
            SEARCH_EXCLUDE_PATTERNS_STATE_KEY,
            typeof message.excludePatternsText === "string"
              ? message.excludePatternsText
              : htmlOptions.defaultExcludePatterns,
          );
          await context.globalState.update(
            SEARCH_USE_DEFAULT_EXCLUDES_STATE_KEY,
            message.useDefaultExcludePatterns !== false,
          );
          const effectiveOptions: SearchOptions = {
            ...options,
            excludePatterns: [
              ...(message.useDefaultExcludePatterns !== false
                ? DEFAULT_SEARCH_EXCLUDE_PATTERNS
                : []),
              ...(options.excludePatterns ?? []),
            ],
          };
          const results = await search(connectionManager, effectiveOptions);
          const selectedDefinition = connectionManager.getDefinition(
            options.connectionId,
          );
          const searchDirectory =
            options.searchDirectory.trim() || selectedDefinition?.path || "/";
          searchPanel?.webview.postMessage({
            type: "results",
            results,
            searchDirectory,
          });
        } catch (error) {
          searchPanel?.webview.postMessage({
            type: "error",
            message: `Unable to search: ${msg(error)}`,
          });
        }
      });
      searchPanel.onDidDispose(() => {
        searchPanel = undefined;
      });
    } else {
      searchPanel.reveal(getOutermostEditorColumn("right"));
      searchPanel.webview.postMessage({
        type: "search-context",
        connectionId: definition.id,
        searchDirectory: defaultSearchDirectory,
      });
    }
  };

  const ensureUniqueName = async (
    node: RemoteNode,
    destination: string,
    newName: string,
    skipCurrentPath?: string,
  ): Promise<boolean> => {
    const connector = await fileOperations.getConnector(node.connectionId);
    const entries = await connector.listDir(destination);
    const duplicate = entries.some(
      (entry) =>
        entry.name === newName &&
        entry.name !== basename(skipCurrentPath ?? ""),
    );

    if (duplicate) {
      const choice = await showSameNameConflict(newName, "rename");
      if (choice === "cancel") {
        throw new CustomError("renameCanceled");
      }
      if (choice === "rename") {
        const retry = await vscode.window.showInputBox({
          prompt: "Rename as",
          value: newName,
          ignoreFocusOut: true,
        });
        if (!retry || !retry.trim()) {
          throw new CustomError("renameCanceled");
        }
        const next = retry.trim();
        if (next === newName) {
          throw new CustomError("nameNotChanged");
        }
        return ensureUniqueName(node, destination, next, skipCurrentPath);
      }
      if (choice === "overwrite") {
        return true;
      }
      throw new CustomError("nameAlreadyExists");
    }

    return false;
  };

  const applyRename = async (node: RemoteNode): Promise<void> => {
    const currentName = basename(node.path);
    const nextName = await vscode.window.showInputBox({
      prompt: `Rename ${currentName}`,
      value: currentName,
      ignoreFocusOut: true,
    });

    if (!nextName || !nextName.trim()) {
      return;
    }

    const trimmed = nextName.trim();
    if (trimmed === currentName) {
      return;
    }

    const parentPath = dirname(node.path);
    try {
      const overwrite = await ensureUniqueName(
        node,
        parentPath,
        trimmed,
        node.path,
      );
      const targetPath = joinPath(parentPath, trimmed);
      await fileOperations.rename(
        { connectionId: node.connectionId, path: node.path },
        { connectionId: node.connectionId, path: targetPath },
        { overwrite },
      );
    } catch (error) {
      if (!(error instanceof CustomError && error.code === "renameCanceled")) {
        void vscode.window.showErrorMessage(
          `Unable to rename ${currentName}: ${msg(error)}`,
        );
      }
      return;
    }

    await treeProvider.refresh();
  };

  const handleDeleteNodes = async (nodes: RemoteNode[]): Promise<void> => {
    const items = nodes.filter((node) =>
      ["file", "directory"].includes(node.type),
    );
    if (items.length === 0 || items.some((item) => item.writable === false)) {
      return;
    }

    try {
      const movedItems = await trashManager.moveItemsToTrash(items, (node) =>
        fileOperations.getConnector(node.connectionId),
      );
      if (movedItems.length === 0) {
        return;
      }

      for (const item of movedItems) {
        fileSystemProvider.notifyDeleted(
          toVirtualUri(item.node.connectionId, item.node.path),
        );
      }
      await treeProvider.refresh();

      const action = await vscode.window.showInformationMessage(
        `${withItemNames(`Deleted ${items.length} item(s)`, items)}.`,
        "Undo",
      );
      if (action === "Undo") {
        for (const item of movedItems) {
          try {
            await item.connector.statPath(item.node.path);
            throw new Error(
              `The original path is no longer available: ${item.node.path}`,
            );
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith(
                "The original path is no longer available:",
              )
            ) {
              throw error;
            }
          }

          await trashManager.restoreItems([item]);
          fileSystemProvider.notifyRestored(
            toVirtualUri(item.node.connectionId, item.node.path),
          );
        }
        await treeProvider.refresh();
        void vscode.window.showInformationMessage(
          `${withItemNames(`Restored ${items.length} item(s)`, items)}.`,
        );
      } else {
        await trashManager.purgeItems(movedItems);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `${withItemNames(`Unable to delete ${items.length} item(s)`, items)}: ${msg(error)}`,
      );
    }
  };

  const handleCutOrCopy = async (
    items: RemoteNode[],
    action: TreeClipboardAction,
  ): Promise<void> => {
    const nodes = items.filter((item) =>
      ["file", "directory"].includes(item.type),
    );
    if (
      nodes.length === 0 ||
      (action === "cut" && nodes.some((item) => item.writable === false))
    ) {
      return;
    }
    clipboardState = { action, items: nodes };
    updateClipboardContext();
    void vscode.window.showInformationMessage(
      withItemNames(
        action === "cut"
          ? `Cut ${nodes.length} item(s)`
          : `Copied ${nodes.length} item(s)`,
        nodes,
      ),
    );
  };

  const handlePaste = async (target: RemoteNode | undefined): Promise<void> => {
    if (
      !clipboardState ||
      ((target?.type === "directory" || target?.type === "connection") &&
        target.writable === false)
    ) {
      return;
    }

    const { action, items } = clipboardState;
    const connectionRoot =
      connectionManager.getDefinition(items[0].connectionId)?.path ?? "/";
    const destination =
      target && ["directory", "connection"].includes(target.type)
        ? target.path
        : target && target.type === "file"
          ? dirname(target.path)
          : connectionRoot;

    try {
      const destinationConnector = await fileOperations.getConnector(
        (target ?? items[0]).connectionId,
      );
      const destinationConnectionId =
        target?.connectionId ?? items[0].connectionId;
      let lastPastedPath: string | undefined;
      for (const item of items) {
        const nextName = basename(item.path);
        const nextPath = joinPath(destination, nextName);
        if (nextPath === item.path && action === "cut") {
          continue;
        }

        const entries = await destinationConnector.listDir(destination);
        const duplicate = entries.some((entry) => entry.name === nextName);
        let resolvedPath = nextPath;
        let overwrite = false;
        if (duplicate) {
          const choice = await showSameNameConflict(nextName, "paste");
          if (choice === "cancel") {
            return;
          }
          if (choice === "rename") {
            const renamed = await vscode.window.showInputBox({
              prompt: "Paste as",
              value: nextName,
              ignoreFocusOut: true,
            });
            if (!renamed || !renamed.trim()) {
              return;
            }
            resolvedPath = joinPath(destination, renamed.trim());
          }
          overwrite = choice === "overwrite";
          if (!choice) {
            return;
          }
        }

        if (action === "cut" && item.connectionId === destinationConnectionId) {
          await fileOperations.rename(
            { connectionId: item.connectionId, path: item.path },
            { connectionId: destinationConnectionId, path: resolvedPath },
            { overwrite },
          );
        } else {
          await fileOperations.copy(
            { connectionId: item.connectionId, path: item.path },
            { connectionId: destinationConnectionId, path: resolvedPath },
            { overwrite },
          );
        }
        lastPastedPath = resolvedPath;
      }
      clipboardState = undefined;
      updateClipboardContext();
      const targetConnection = target?.connectionId ?? items[0].connectionId;
      await treeProvider.revealNode(
        treeProvider.getDirectoryNode(targetConnection, destination, target),
        TO_EXPAND,
      );
      await treeProvider.refresh();
      await treeProvider.selectNode(
        targetConnection,
        destination,
        lastPastedPath,
        target,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to paste ${formatItemNameSummary(items)} to ${destination}: ${msg(error)}`,
      );
    }
  };

  const uploadLocalEntry = async (
    connector: IRemoteConnector,
    connectionId: string,
    source: vscode.Uri,
    destination: string,
    targetName: string,
  ): Promise<void> => {
    const targetPath = joinPath(destination, targetName);
    const { type: fileType } = await vscode.workspace.fs.stat(source);

    if (fileType & vscode.FileType.Directory) {
      await fileOperations.createDirectory({
        connectionId,
        path: targetPath,
      });
      const children = await vscode.workspace.fs.readDirectory(source);
      for (const [childName] of children) {
        await uploadLocalEntry(
          connector,
          connectionId,
          vscode.Uri.joinPath(source, childName),
          targetPath,
          childName,
        );
      }
      return;
    }

    await connector.uploadFile(source.fsPath, targetPath);
  };

  const handleUpload = async (
    target: RemoteNode | undefined,
  ): Promise<void> => {
    if (
      !target ||
      !["directory", "connection"].includes(target.type) ||
      target.writable === false
    ) {
      return;
    }

    const sources = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "Upload",
    });
    if (!sources || sources.length === 0) {
      return;
    }

    treeProvider.loading.set(target, 200);
    try {
      const connector = await fileOperations.getConnector(target.connectionId);
      let lastUploadedPath: string | undefined;
      for (const source of sources) {
        let targetName = basename(source.path);
        while (true) {
          const entries = await connector.listDir(target.path);
          if (!entries.some((entry) => entry.name === targetName)) {
            break;
          }

          const choice = await showSameNameConflict(targetName, "upload");
          if (choice === "cancel" || !choice) {
            targetName = "";
            break;
          }
          if (choice === "rename") {
            const renamed = await vscode.window.showInputBox({
              prompt: "Upload as",
              value: targetName,
              ignoreFocusOut: true,
            });
            if (!renamed || !renamed.trim()) {
              targetName = "";
              break;
            }
            targetName = renamed.trim();
          } else {
            await connector.deletePath(joinPath(target.path, targetName));
            break;
          }
        }

        if (!targetName) {
          continue;
        }

        await uploadLocalEntry(
          connector,
          target.connectionId,
          source,
          target.path,
          targetName,
        );
        lastUploadedPath = joinPath(target.path, targetName);
      }
      await treeProvider.revealNode(
        treeProvider.getDirectoryNode(target.connectionId, target.path, target),
        TO_EXPAND,
      );
      await treeProvider.refresh();
      await treeProvider.selectNode(
        target.connectionId,
        target.path,
        lastUploadedPath,
        target,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to upload ${formatItemNameSummary(
          sources.map((source) => ({ path: source.path })),
        )} to ${target.path}: ${msg(error)}`,
      );
    } finally {
      treeProvider.loading.clear(target);
    }
  };

  treeView.onDidChangeSelection((event) => {
    updateSelectedNodeContext(event.selection);
  });
  updateSelectedNodeContext();

  context.subscriptions.push(
    connectionManager,
    diffManager,
    vscode.workspace.registerFileSystemProvider(
      "remote-file-manager",
      fileSystemProvider,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      diffManager,
    ),
    treeView,
    vscode.commands.registerCommand("remoteFileManager.refresh", () => {
      void treeProvider.refresh();
    }),
    vscode.commands.registerCommand(
      "remoteFileManager.showReadonlyStatus",
      () => undefined,
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.openTerminal",
      openRemoteTerminal,
    ),
    vscode.commands.registerCommand("remoteFileManager.search", openSearch),
    vscode.commands.registerCommand(
      "revealInExplorer",
      async (uri?: vscode.Uri) => {
        const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (resource?.scheme === "remote-file-manager") {
          await revealRemoteUri(resource);
          return;
        }

        await vscode.commands.executeCommand(
          "workbench.files.action.showActiveFileInExplorer",
        );
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.editWithDiff",
      async (node?: RemoteNode) => {
        if (!node || node.type !== "file") {
          return;
        }

        treeProvider.loading.set(node, 200);
        try {
          await diffManager.open(node);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to open diff for ${node.path}: ${msg(error)}`,
          );
        } finally {
          treeProvider.loading.clear(node);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.openFile",
      async (node?: RemoteNode) => {
        if (!node || node.type !== "file") {
          return;
        }

        treeProvider.loading.set(node, 200);
        try {
          const uri = toVirtualUri(node.connectionId, node.path);
          const now = Date.now();
          const isDoubleClick =
            lastOpenedFile?.connectionId === node.connectionId &&
            lastOpenedFile.path === node.path &&
            now - lastOpenedFile.timestamp <=
              TREE_FILE_DOUBLE_CLICK_INTERVAL_MS;
          lastOpenedFile = {
            connectionId: node.connectionId,
            path: node.path,
            timestamp: now,
          };
          await vscode.commands.executeCommand("vscode.open", uri, {
            preview: !isDoubleClick,
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: true,
          });
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to open ${node.path}: ${msg(error)}`,
          );
        } finally {
          treeProvider.loading.clear(node);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.locateTarget",
      async (node?: RemoteNode) => {
        const target = resolveTreeCommandNode(node, treeView.selection);
        if (!target?.isSymbolicLink) {
          return;
        }

        try {
          const connector = await fileOperations.getConnector(
            target.connectionId,
          );
          const stats = await connector.statPath(target.path);
          if (!stats.linkTarget) {
            void vscode.window.showWarningMessage(
              `Unable to locate the target of ${target.label}: broken symbolic link`,
            );
            return;
          }
          await revealRemoteUri(
            toVirtualUri(target.connectionId, stats.linkTarget),
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to locate the target of ${target.label}: ${msg(error)}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.goToPath",
      async (node?: RemoteNode) => {
        const target = resolveTreeCommandNode(node, treeView.selection);
        if (!target || target.type !== "connection") {
          return;
        }

        const definition = connectionManager.getDefinition(target.connectionId);
        if (!definition) {
          return;
        }

        const targetPath = await vscode.window.showInputBox({
          title: `Go to path in ${target.connectionId}`,
          prompt: "Enter a remote path to reveal in the tree",
          placeHolder: "/var/log",
          value: normalizeRemotePath(definition.path ?? "/"),
          ignoreFocusOut: true,
          validateInput: (value) =>
            value.trim() ? undefined : "Enter a remote path.",
        });
        if (targetPath === undefined) {
          return;
        }

        const normalizedPath = normalizeRemotePath(targetPath.trim());
        const resolved = await treeProvider.revealPath(
          target.connectionId,
          normalizedPath,
        );
        if (!resolved) {
          void vscode.window.showWarningMessage(
            `Remote path not found: ${normalizedPath}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.download",
      async (node?: RemoteNode) => {
        const targets = resolveTreeCommandNodes(
          node,
          treeView.selection,
        ).filter((target) => ["file", "directory"].includes(target.type));
        if (targets.length === 0) {
          return;
        }
        if (new Set(targets.map((target) => target.connectionId)).size > 1) {
          void vscode.window.showErrorMessage(
            withItemNames(
              "Batch download requires items from the same connection",
              targets,
            ),
          );
          return;
        }

        try {
          const connector = await fileOperations.getConnector(
            targets[0].connectionId,
          );
          await downloadNodes(targets, connector);
        } catch (error) {
          if (!(
            error instanceof CustomError && error.code === "downloadCanceled"
          )) {
            void vscode.window.showErrorMessage(
              `${withItemNames(`Unable to download ${targets.length} item(s)`, targets)}: ${msg(error)}`,
            );
          }
        }
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.copyPath",
      async (node?: RemoteNode) => {
        const target = resolveTreeCommandNode(node, treeView.selection);
        if (!target || !["file", "directory"].includes(target.type)) {
          return;
        }

        await vscode.env.clipboard.writeText(target.path);
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.createFile",
      async (node?: RemoteNode) => {
        if (
          !node ||
          (node.type !== "directory" && node.type !== "connection") ||
          node.writable === false
        ) {
          return;
        }

        const name = await vscode.window.showInputBox({
          prompt: "New file name",
          placeHolder: "example.txt",
        });

        if (!name || !name.trim()) {
          return;
        }

        treeProvider.loading.set(node, 200);
        try {
          const connector = await fileOperations.getConnector(
            node.connectionId,
          );
          const path = joinPath(node.path, name.trim());
          await connector.createFile(path);
          await treeProvider.revealNode(node, TO_EXPAND);
          await treeProvider.refresh();
          await treeProvider.selectNode(
            node.connectionId,
            node.path,
            path,
            node,
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to create file ${name.trim()} in ${node.path}: ${msg(error)}`,
          );
        } finally {
          treeProvider.loading.clear(node);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.createFolder",
      async (node?: RemoteNode) => {
        if (
          !node ||
          (node.type !== "directory" && node.type !== "connection") ||
          node.writable === false
        ) {
          return;
        }

        const name = await vscode.window.showInputBox({
          prompt: "New folder name",
          placeHolder: "new-folder",
        });

        if (!name || !name.trim()) {
          return;
        }

        treeProvider.loading.set(node, 200);
        try {
          const path = joinPath(node.path, name.trim());
          await fileOperations.createDirectory({
            connectionId: node.connectionId,
            path,
          });
          await treeProvider.revealNode(node, TO_EXPAND);
          await treeProvider.refresh();
          await treeProvider.selectNode(
            node.connectionId,
            node.path,
            path,
            node,
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to create folder ${name.trim()} in ${node.path}: ${msg(error)}`,
          );
        } finally {
          treeProvider.loading.clear(node);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.uploadFiles",
      async (node?: RemoteNode) => {
        const target = resolveTreeCommandNode(node, treeView.selection);
        await handleUpload(target);
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.getInfo",
      async (node?: RemoteNode) => {
        const target = resolveTreeCommandNode(node, treeView.selection);
        if (
          !target ||
          (target.type !== "file" && target.type !== "directory")
        ) {
          return;
        }

        try {
          const connector = await fileOperations.getConnector(
            target.connectionId,
          );
          const stats = await connector.statPath(target.path);
          const requestId = ++infoRequestId;
          const currentPathUri = toVirtualUri(
            target.connectionId,
            target.path,
          ).toString();
          const linkTargetUri = stats.linkTarget
            ? toVirtualUri(target.connectionId, stats.linkTarget).toString()
            : undefined;
          if (infoPanel) {
            infoPanel.reveal(getOutermostEditorColumn("left"));
            infoPanel.title = getInfoTitle(target.label);
          } else {
            const reuseExistingGroup = vscode.window.tabGroups.all.length > 1;
            let infoColumn = reuseExistingGroup
              ? getOutermostEditorColumn("left")
              : vscode.ViewColumn.Beside;
            if (
              !reuseExistingGroup &&
              vscode.window.visibleTextEditors.length === 0
            ) {
              const anchorDocument = await vscode.workspace.openTextDocument({
                language: "plaintext",
                content: "",
              });
              await vscode.window.showTextDocument(anchorDocument, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: true,
                preview: true,
              });
              infoColumn = vscode.ViewColumn.Two;
            }
            infoPanel = vscode.window.createWebviewPanel(
              "remoteFileManager.getInfo",
              getInfoTitle(target.label),
              infoColumn,
              { enableScripts: true },
            );
            if (!reuseExistingGroup) {
              await vscode.commands.executeCommand(
                "workbench.action.moveActiveEditorGroupLeft",
              );
            }
            infoPanel.webview.onDidReceiveMessage((message) => {
              if (
                message?.type === "open-uri" &&
                typeof message.uri === "string"
              ) {
                const originUri = vscode.Uri.parse(message.uri);
                void revealRemoteUri(originUri);
              }
            });
            infoPanel.onDidDispose(() => {
              infoPanel = undefined;
            });
            if (!reuseExistingGroup) {
              await resizeInfoPanel();
            }
          }
          const panel = infoPanel;
          panel.webview.html = createInfoHtml({
            node: target,
            stats,
            sizeText: target.type === "directory" ? "loading" : undefined,
            linkTargetUri,
            currentPathUri,
          });
          if (target.type === "directory") {
            void connector
              .getDirectorySize(target.path)
              .then((size) => {
                if (requestId !== infoRequestId || !infoPanel) {
                  return;
                }
                panel.webview.html = createInfoHtml({
                  node: target,
                  stats: {
                    ...stats,
                    size,
                  },
                  linkTargetUri,
                  currentPathUri,
                });
              })
              .catch(() => {
                if (requestId === infoRequestId && infoPanel) {
                  panel.webview.html = createInfoHtml({
                    node: target,
                    stats,
                    sizeText: "Unavailable",
                    linkTargetUri,
                    currentPathUri,
                  });
                }
              });
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to get info for ${target.label}: ${msg(error)}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.renameNode",
      async (node?: RemoteNode) => {
        const target = resolveTreeCommandNode(node, treeView.selection);
        if (
          !target ||
          !["file", "directory"].includes(target.type) ||
          target.writable === false
        ) {
          return;
        }
        await applyRename(target);
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.deleteNode",
      async (node?: RemoteNode) => {
        await handleDeleteNodes(
          resolveTreeCommandNodes(node, treeView.selection),
        );
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.cutNode",
      async (node?: RemoteNode) => {
        await handleCutOrCopy(
          resolveTreeCommandNodes(node, treeView.selection),
          "cut",
        );
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.copyNode",
      async (node?: RemoteNode) => {
        await handleCutOrCopy(
          resolveTreeCommandNodes(node, treeView.selection),
          "copy",
        );
      },
    ),
    vscode.commands.registerCommand(
      "remoteFileManager.pasteNode",
      async (node?: RemoteNode) => {
        const target = resolveTreeCommandNode(node, treeView.selection);
        await handlePaste(target);
      },
    ),
    vscode.commands.registerCommand("remoteFileManager.pasteRoot", async () => {
      const target = await resolveConnectionRootTarget();
      if (target?.type === "directory" && target.writable === false) {
        return;
      }
      if (!target) {
        void vscode.window.showWarningMessage(
          "Select a connection or keep only one configured connection before pasting into the root.",
        );
        return;
      }

      await handlePaste(target);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(REMOTE_FILE_MANAGER_CONNECTIONS_CONFIG_KEY)
      ) {
        void treeProvider.refresh();
      }
    }),
    vscode.languages.registerDefinitionProvider(
      { scheme: "remote-file-manager" },
      new RemoteDefinitionProvider(),
    ),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document.uri.scheme !== "remote-file-manager") {
        return;
      }

      try {
        const connector = connectionManager.getConnectorOrThrow(
          document.uri.authority,
        );
        await connector.writeFile(
          decodeRemotePath(document.uri),
          Buffer.from(document.getText(), "utf8"),
        );
        const health = connectionManager.getHealth(document.uri.authority);
        if (!health.isConnected) {
          connectionManager.setHealth(document.uri.authority, {
            isConnected: true,
            lastCheckedAt: Date.now(),
          });
        }
        void treeProvider.refresh();
      } catch (error) {
        connectionManager.setHealth(document.uri.authority, {
          isConnected: false,
          lastCheckedAt: Date.now(),
          lastError: msg(error, "Unknown save error"),
        });
        void treeProvider.refresh();
        void vscode.window.showErrorMessage(
          `Failed to save ${document.uri.path}: ${msg(error)}`,
        );
      }
    }),
  );
}

export function deactivate(): void {
  // no-op
}

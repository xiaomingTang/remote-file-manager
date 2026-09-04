import * as vscode from "vscode";
import { ConnectionManager } from "../config";
import { RemoteNode } from "../types";
import {
  basename,
  dirname,
  joinPath,
  resolveDropTargetPath,
  resolveNameConflict,
  toVirtualUri,
} from "../utils";
import { msg } from "../error/message";
import { RemoteFileOperations } from "../services/file-operations";
import { LoadingManager } from "../loading";
import { RemoteFileManagerFileSystemProvider } from "./fs";

type RevealOptions = {
  expand?: boolean | number;
  focus?: boolean;
  select?: boolean;
};

export const TO_EXPAND: RevealOptions = {
  expand: true,
  focus: false,
  select: false,
};
export const TO_FOCUS: RevealOptions = {
  expand: false,
  focus: true,
  select: true,
};

export class RemoteTreeDragAndDropController implements vscode.TreeDragAndDropController<RemoteNode> {
  readonly dropMimeTypes = ["application/vnd.code.tree.remotefilemanagerview"];
  readonly dragMimeTypes = ["application/vnd.code.tree.remotefilemanagerview"];

  constructor(
    private readonly fileOperations: RemoteFileOperations,
    private readonly treeProvider: RemoteTreeDataProvider,
    private readonly fileSystemProvider: RemoteFileManagerFileSystemProvider,
  ) {}

  async handleDrag(
    source: readonly RemoteNode[],
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const payload = source
      .filter(
        (node) =>
          node.connectionId !== "__new__" &&
          node.type !== "connection" &&
          node.path,
      )
      .map((node) => ({ connectionId: node.connectionId, path: node.path }));

    if (payload.length === 0) {
      return;
    }

    dataTransfer.set(
      "application/vnd.code.tree.remotefilemanagerview",
      new vscode.DataTransferItem(payload),
    );
  }

  async handleDrop(
    target: RemoteNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    if (
      (target?.type === "directory" || target?.type === "connection") &&
      target.writable === false
    ) {
      return;
    }

    const payloadItem = dataTransfer.get(
      "application/vnd.code.tree.remotefilemanagerview",
    );
    if (!payloadItem) {
      return;
    }

    const payload = payloadItem.value as
      Array<{ connectionId: string; path: string }> | undefined;
    if (!payload || payload.length === 0) {
      return;
    }

    const targetConnectionId = target?.connectionId ?? payload[0].connectionId;
    const targetPath = target
      ? target.type === "file"
        ? dirname(target.path)
        : target.path
      : "/";
    try {
      const targetConnector =
        await this.fileOperations.getConnector(targetConnectionId);
      let lastMovedPath: string | undefined;

      for (const entry of payload) {
        const nextPath = resolveDropTargetPath(entry.path, targetPath);
        if (
          entry.connectionId === targetConnectionId &&
          entry.path === nextPath
        ) {
          continue;
        }

        const nextName = basename(nextPath);
        const decision = await resolveNameConflict(
          "drop",
          nextName,
          async (candidate) => {
            const entries = await targetConnector.listDir(targetPath);
            return entries.some((item) => item.name === candidate);
          },
        );
        if (decision?.action === "cancel") {
          continue;
        }
        const resolvedName =
          decision?.action === "rename" ? decision.payload : nextName;
        const resolvedPath = joinPath(targetPath, resolvedName);
        if (entry.connectionId === targetConnectionId) {
          await this.fileOperations.rename(
            { connectionId: entry.connectionId, path: entry.path },
            { connectionId: targetConnectionId, path: resolvedPath },
            { overwrite: decision?.action === "overwrite" },
          );
          this.fileSystemProvider.notifyMoved(
            toVirtualUri(entry.connectionId, entry.path),
            toVirtualUri(targetConnectionId, resolvedPath),
          );
        } else {
          await this.fileOperations.copy(
            { connectionId: entry.connectionId, path: entry.path },
            { connectionId: targetConnectionId, path: resolvedPath },
            { overwrite: decision?.action === "overwrite" },
          );
          this.fileSystemProvider.notifyRestored(
            toVirtualUri(targetConnectionId, resolvedPath),
          );
        }
        lastMovedPath = resolvedPath;
      }

      const targetConnection = target?.connectionId ?? payload[0].connectionId;
      await this.treeProvider.revealNode(
        this.treeProvider.getDirectoryNode(
          targetConnection,
          targetPath,
          target,
        ),
        TO_EXPAND,
      );
      await this.treeProvider.refresh();
      await this.treeProvider.selectNode(
        targetConnection,
        targetPath,
        lastMovedPath,
        target,
      );

      if (lastMovedPath && payload.length === 1) {
        await vscode.commands.executeCommand(
          "vscode.open",
          toVirtualUri(targetConnection, lastMovedPath),
          {
            preview: true,
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: true,
          },
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to drop item: ${msg(error)}`);
    }
  }
}

export class RemoteTreeDataProvider implements vscode.TreeDataProvider<RemoteNode> {
  private readonly connectionManager: ConnectionManager;
  private readonly eventEmitter = new vscode.EventEmitter<
    RemoteNode | undefined | null | void
  >();
  private readonly directoryCache = new Map<string, RemoteNode[]>();
  private readonly directoryNodes = new Map<string, RemoteNode>();
  private readonly writableCache = new Map<string, boolean>();
  private treeView?: vscode.TreeView<RemoteNode>;
  readonly loading: LoadingManager<RemoteNode>;

  readonly onDidChangeTreeData = this.eventEmitter.event;

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
    this.loading = new LoadingManager(
      (node) => `${node.connectionId}:${node.path}:${node.type}`,
      (node) => this.eventEmitter.fire(node),
    );
  }

  setTreeView(treeView: vscode.TreeView<RemoteNode>): void {
    this.treeView = treeView;
  }

  getDirectoryNode(
    connectionId: string,
    directoryPath: string,
    preferredNode?: RemoteNode,
  ): RemoteNode | undefined {
    if (
      preferredNode &&
      preferredNode.connectionId === connectionId &&
      (preferredNode.type === "directory" ||
        preferredNode.type === "connection") &&
      preferredNode.path === directoryPath
    ) {
      return preferredNode;
    }

    const definition = this.connectionManager.getDefinition(connectionId);
    if (!definition) {
      return undefined;
    }

    if (definition.path === directoryPath) {
      return {
        connectionId,
        label: connectionId,
        path: directoryPath,
        type: "connection",
        icon: "cloud",
        writable: this.getCachedWritable(connectionId, directoryPath),
      };
    }

    return {
      connectionId,
      label: basename(directoryPath),
      path: directoryPath,
      type: "directory",
      icon: "folder",
      writable: this.getCachedWritable(connectionId, directoryPath),
    };
  }

  async revealPath(
    connectionId: string,
    targetPath: string,
  ): Promise<RemoteNode | undefined> {
    const definition = this.connectionManager.getDefinition(connectionId);
    if (!definition) {
      return undefined;
    }

    const rootPath = definition.path ?? "/";
    const root = this.getDirectoryNode(connectionId, rootPath);
    if (!root) {
      return undefined;
    }

    const normalizedTarget = targetPath.replace(/\\/g, "/");
    const normalizedRoot =
      rootPath.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    const isRoot = normalizedRoot === "/";
    if (
      normalizedTarget !== normalizedRoot &&
      !(isRoot
        ? normalizedTarget.startsWith("/")
        : normalizedTarget.startsWith(`${normalizedRoot}/`))
    ) {
      return undefined;
    }

    await this.revealNode(root, TO_EXPAND);
    if (normalizedTarget === normalizedRoot) {
      return root;
    }

    const relativePath = isRoot
      ? normalizedTarget.slice(1)
      : normalizedTarget.slice(normalizedRoot.length + 1);
    const segments = relativePath.split("/").filter(Boolean);
    let current = root;
    for (const segment of segments) {
      const childPath = joinPath(current.path, segment);
      const child = (await this.getChildren(current)).find(
        (candidate) => candidate.path === childPath,
      );
      if (!child) {
        return undefined;
      }

      current = child;
      if (current.type === "directory") {
        await this.revealNode(current, TO_EXPAND);
      }
    }

    await this.revealNode(current, TO_FOCUS);
    return current;
  }

  async revealNode(
    node: RemoteNode | undefined,
    options: RevealOptions,
  ): Promise<void> {
    if (!this.treeView || !node) {
      return;
    }

    try {
      await this.treeView.reveal(node, options);
    } catch {
      // Ignore reveal failures. The tree can still refresh and render correctly.
    }
  }

  async selectNode(
    connectionId: string,
    directoryPath: string,
    path: string | undefined,
    preferredNode?: RemoteNode,
  ): Promise<void> {
    const directory = this.getDirectoryNode(
      connectionId,
      directoryPath,
      preferredNode,
    );
    if (!directory) {
      return;
    }

    const children = await this.getChildren(directory);
    if (!path) {
      return;
    }

    const node = children.find((child) => child.path === path);
    if (!node) {
      return;
    }

    await this.revealNode(node, TO_FOCUS);
  }

  async refresh(): Promise<void> {
    this.loading.clear(undefined, false);
    this.directoryCache.clear();
    this.directoryNodes.clear();
    this.writableCache.clear();
    this.eventEmitter.fire(undefined);
  }

  private getCacheKey(node: Pick<RemoteNode, "connectionId" | "path">): string {
    return `${node.connectionId}:${node.path}`;
  }

  private getCachedWritable(
    connectionId: string,
    path: string,
  ): boolean | undefined {
    return this.writableCache.get(`${connectionId}:${path}`);
  }

  private setCachedWritable(
    connectionId: string,
    path: string,
    writable: boolean,
  ): void {
    this.writableCache.set(`${connectionId}:${path}`, writable);
  }

  private async listDirectoryChildren(
    element: RemoteNode,
  ): Promise<RemoteNode[]> {
    const cacheKey = this.getCacheKey(element);
    this.directoryNodes.set(cacheKey, element);
    const cached = this.directoryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const connector = this.connectionManager.getConnector(element.connectionId);
    if (!connector) {
      return [];
    }

    const entries = await connector.listDir(element.path);
    this.connectionManager.setHealth(element.connectionId, {
      isConnected: true,
      lastCheckedAt: Date.now(),
    });
    const mapped: RemoteNode[] = entries.map((entry) => {
      const path = joinPath(element.path, entry.name);
      this.setCachedWritable(element.connectionId, path, entry.writable);
      const prefix = entry.isSymbolicLink
        ? entry.isBrokenSymbolicLink
          ? "🔗 ⚠️ "
          : "🔗 "
        : "";
      return {
        connectionId: element.connectionId,
        label: `${prefix}${entry.name}`,
        path,
        type: entry.isDirectory ? "directory" : "file",
        icon: entry.isDirectory ? "folder" : "file-code",
        writable: entry.writable,
        isSymbolicLink: entry.isSymbolicLink,
        isBrokenSymbolicLink: entry.isBrokenSymbolicLink,
      };
    });

    this.directoryCache.set(cacheKey, mapped);
    return mapped;
  }

  getTreeItem(element: RemoteNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.type === "directory" || element.type === "connection"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    item.id = `${element.connectionId}:${element.type}:${element.path}`;
    const contextType = element.isSymbolicLink
      ? `${element.type}.symlink`
      : element.type;
    item.contextValue =
      element.writable === false ? `${contextType}.readonly` : contextType;
    if (element.writable !== undefined) {
      item.tooltip = element.writable ? "Writable" : "Read-only";
    }

    if (this.loading.has(element)) {
      item.iconPath = new vscode.ThemeIcon("loading~spin");
    } else if (element.connectionId === "__new__") {
      item.iconPath = new vscode.ThemeIcon("plus");
    } else if (element.type === "connection") {
      item.iconPath = new vscode.ThemeIcon("cloud");
    }

    if (element.connectionId === "__new__") {
      item.command = {
        command: "remoteFileManager.manageConnections",
        title: "Manage Connections",
        arguments: [element],
      };
      item.tooltip = "Add a Docker or SSH connection";
      return item;
    }

    item.resourceUri = toVirtualUri(element.connectionId, element.path);

    if (element.type === "file") {
      item.command = {
        command: "remoteFileManager.openFile",
        title: "Open File",
        arguments: [element],
      };
    }

    return item;
  }

  async getChildren(element?: RemoteNode): Promise<RemoteNode[]> {
    try {
      if (!element) {
        const definitions = this.connectionManager.getDefinitions();
        if (definitions.length === 0) {
          return [
            {
              connectionId: "__new__",
              label: "Add connection",
              path: "/",
              type: "connection",
              icon: "plus",
            },
          ];
        }

        return definitions.map((def) => ({
          connectionId: def.id,
          label: def.id,
          path: def.path ?? "/",
          type: "connection" as const,
          icon: "cloud",
          writable: this.getCachedWritable(def.id, def.path ?? "/"),
        }));
      }

      const children = await this.listDirectoryChildren(element);
      return children;
    } catch (error) {
      if (element) {
        this.connectionManager.setHealth(element.connectionId, {
          isConnected: false,
          lastCheckedAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
      void vscode.window.showErrorMessage(
        `Failed to browse ${element?.path ?? "/"}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  getParent(element: RemoteNode): RemoteNode | undefined {
    if (element.type === "connection" || element.connectionId === "__new__") {
      return undefined;
    }

    const definition = this.connectionManager.getDefinition(
      element.connectionId,
    );
    if (!definition) {
      return undefined;
    }

    const parentPath = dirname(element.path);
    if (parentPath === element.path) {
      return undefined;
    }

    return this.getDirectoryNode(element.connectionId, parentPath);
  }
}

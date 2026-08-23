import { REMOTE_FILE_MANAGER_TRASH_ROOT } from "../constants";
import { IRemoteConnector, RemoteNode } from "../types";
import { dirname, resolveTrashPath } from "../utils";

export interface TrashMovedItem {
  connector: IRemoteConnector;
  node: RemoteNode;
  trashPath: string;
}

export class TrashManager {
  private lastTrashTimestamp = 0;
  private lastDeleteAt: number | undefined;
  private readonly trashConnectors = new Map<string, IRemoteConnector>();

  async moveItemsToTrash(
    nodes: RemoteNode[],
    resolveConnector: (node: RemoteNode) => Promise<IRemoteConnector>,
  ): Promise<TrashMovedItem[]> {
    const items = nodes.filter((node) =>
      ["file", "directory"].includes(node.type),
    );
    if (items.length === 0) {
      return [];
    }

    const currentDeleteAt = Date.now();
    if (this.shouldCleanupTrash(currentDeleteAt)) {
      await this.cleanupTrashRoots();
    }
    this.lastDeleteAt = currentDeleteAt;

    const roots = items.filter(
      (node) =>
        !items.some(
          (parent) =>
            parent !== node &&
            parent.connectionId === node.connectionId &&
            node.path.startsWith(
              parent.path.endsWith("/") ? parent.path : `${parent.path}/`,
            ),
        ),
    );

    const connectors = new Map<string, IRemoteConnector>();
    for (const node of roots) {
      const connector = await resolveConnector(node);
      connectors.set(node.connectionId, connector);
      this.trashConnectors.set(node.connectionId, connector);
    }

    const movedItems: TrashMovedItem[] = [];
    for (const node of roots) {
      const connector = connectors.get(node.connectionId);
      if (!connector) {
        continue;
      }

      this.lastTrashTimestamp = Math.max(
        Date.now(),
        this.lastTrashTimestamp + 1,
      );
      const trashPath = resolveTrashPath(node.path, this.lastTrashTimestamp);
      await connector.movePath(node.path, trashPath);
      movedItems.push({ connector, node, trashPath });
    }

    return movedItems;
  }

  async restoreItems(items: TrashMovedItem[]): Promise<void> {
    for (const item of items) {
      await item.connector.movePath(item.trashPath, item.node.path);
      await item.connector.deletePath(dirname(item.trashPath));
    }
  }

  async purgeItems(items: TrashMovedItem[]): Promise<void> {
    for (const item of items) {
      await item.connector.deletePath(dirname(item.trashPath));
    }
  }

  private shouldCleanupTrash(currentDeleteAt: number): boolean {
    return (
      this.lastDeleteAt !== undefined &&
      currentDeleteAt - this.lastDeleteAt > 180_000
    );
  }

  private async cleanupTrashRoots(): Promise<void> {
    for (const connector of this.trashConnectors.values()) {
      await connector.deletePath(REMOTE_FILE_MANAGER_TRASH_ROOT);
    }
    this.trashConnectors.clear();
  }
}

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { IRemoteConnector, RemoteNode } from "../types";

function isSqliteFile(node: RemoteNode): boolean {
  return node.type === "file" && node.label.toLowerCase().endsWith(".db");
}

export async function prepareSqlitePreview(
  node: RemoteNode,
  connector: IRemoteConnector,
): Promise<string | undefined> {
  if (!isSqliteFile(node)) {
    return undefined;
  }

  const previewDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "remote-file-manager-sqlite-"),
  );
  const databaseName = path.basename(node.path);
  const localDatabasePath = path.join(previewDirectory, databaseName);

  try {
    await connector.downloadPath(node.path, localDatabasePath);

    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${node.path}${suffix}`;
      try {
        await connector.statPath(sidecarPath);
      } catch {
        continue;
      }
      await connector.downloadPath(
        sidecarPath,
        `${localDatabasePath}${suffix}`,
      );
    }

    return localDatabasePath;
  } catch (error) {
    await fs.rm(previewDirectory, { recursive: true, force: true });
    throw error;
  }
}

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { IRemoteConnector } from "../types";
import { basename, joinPath } from "../utils";

async function uploadLocalPath(
  connector: IRemoteConnector,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const stat = await fs.stat(localPath);
  if (stat.isDirectory()) {
    await connector.createDirectory(remotePath);
    const children = await fs.readdir(localPath);
    for (const childName of children) {
      await uploadLocalPath(
        connector,
        path.join(localPath, childName),
        joinPath(remotePath, childName),
      );
    }
    return;
  }

  await connector.uploadFile(localPath, remotePath);
}

export async function copyPathAcrossConnections(
  sourceConnector: IRemoteConnector,
  destinationConnector: IRemoteConnector,
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "remote-file-manager-"),
  );
  const stagedPath = path.join(temporaryDirectory, basename(sourcePath));

  try {
    await sourceConnector.downloadPath(sourcePath, stagedPath);
    await uploadLocalPath(destinationConnector, stagedPath, destinationPath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

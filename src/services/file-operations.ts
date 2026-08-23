import { ConnectionManager } from "../config";
import { CustomError } from "../error/custom-error";
import { IRemoteConnector } from "../types";
import { copyPathAcrossConnections } from "./transfer";

export interface RemotePath {
  connectionId: string;
  path: string;
}

export interface FileOperationOptions {
  overwrite?: boolean;
}

export class RemoteFileOperations {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async getConnector(connectionId?: string | null): Promise<IRemoteConnector> {
    if (!connectionId?.trim()) {
      throw new CustomError("noConnectorSelected");
    }

    const isConnected =
      await this.connectionManager.validateConnection(connectionId);
    if (!isConnected) {
      throw new CustomError("connectionUnavailable").v({ connectionId });
    }

    const connector = this.connectionManager.getConnector(connectionId);
    if (!connector) {
      throw new CustomError("noConnector").v({ connectionId });
    }

    return connector;
  }

  async rename(
    source: RemotePath,
    target: RemotePath,
    options: FileOperationOptions = {},
  ): Promise<void> {
    if (source.connectionId !== target.connectionId) {
      throw new CustomError("cannotMoveAcrossConnections");
    }
    if (source.path === target.path) {
      return;
    }

    const connector = await this.getConnector(source.connectionId);
    await this.prepareTarget(
      connector,
      target.path,
      options.overwrite === true,
    );
    await connector.movePath(source.path, target.path);
  }

  async copy(
    source: RemotePath,
    target: RemotePath,
    options: FileOperationOptions = {},
  ): Promise<void> {
    const sourceConnector = await this.getConnector(source.connectionId);
    await this.prepareTarget(
      await this.getConnector(target.connectionId),
      target.path,
      options.overwrite === true,
    );

    if (source.connectionId === target.connectionId) {
      await sourceConnector.copyPath(source.path, target.path);
      return;
    }

    const targetConnector = await this.getConnector(target.connectionId);
    await copyPathAcrossConnections(
      sourceConnector,
      targetConnector,
      source.path,
      target.path,
    );
  }

  async createDirectory(target: RemotePath): Promise<void> {
    const connector = await this.getConnector(target.connectionId);
    await connector.createDirectory(target.path);
  }

  private async prepareTarget(
    connector: IRemoteConnector,
    targetPath: string,
    overwrite: boolean,
  ): Promise<void> {
    const targetExists = await this.pathExists(connector, targetPath);
    if (!targetExists) {
      return;
    }
    if (!overwrite) {
      throw new CustomError("nameAlreadyExists");
    }

    await connector.deletePath(targetPath);
  }

  private async pathExists(
    connector: IRemoteConnector,
    path: string,
  ): Promise<boolean> {
    try {
      await connector.statPath(path);
      return true;
    } catch {
      return false;
    }
  }
}

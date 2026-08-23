import * as vscode from "vscode";
import { ConnectionManager } from "../config";
import { CustomError } from "../error/custom-error";
import {
  FileOperationOptions,
  RemoteFileOperations,
  RemotePath,
} from "../services/file-operations";
import {
  decodeRemotePath,
  dirname,
  resolveImportPath,
  toVirtualUri,
} from "../utils";

function prepareThrowFileSystemError(uri: vscode.Uri) {
  return (error: unknown): never => {
    if (error instanceof CustomError) {
      if (error.code === "noConnector") {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (error.code === "nameAlreadyExists") {
        throw vscode.FileSystemError.FileExists(uri);
      }
      if (error.code === "noConnectorSelected") {
        throw vscode.FileSystemError.Unavailable(uri);
      }
      if (error.code === "connectionUnavailable") {
        throw vscode.FileSystemError.Unavailable(uri);
      }
      if (error.code === "cannotMoveAcrossConnections") {
        throw vscode.FileSystemError.Unavailable(uri);
      }
    }
    throw error;
  };
}

export class RemoteFileManagerFileSystemProvider
  implements vscode.FileSystemProvider
{
  private readonly fileOperations: RemoteFileOperations;
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();

  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  constructor(connectionManager: ConnectionManager) {
    this.fileOperations = new RemoteFileOperations(connectionManager);
  }

  private toRemotePath(uri: vscode.Uri): RemotePath {
    return {
      connectionId: uri.authority,
      path: decodeRemotePath(uri),
    };
  }

  private async getConnector(uri: vscode.Uri) {
    return await this.fileOperations
      .getConnector(uri.authority)
      .catch(prepareThrowFileSystemError(uri));
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const path = decodeRemotePath(uri);
    const connector = await this.getConnector(uri);

    if (!path || path === "/") {
      return {
        type: vscode.FileType.Directory,
        ctime: Date.now(),
        mtime: Date.now(),
        size: 0,
      };
    }

    const stats = await connector.statPath(path).catch(() => {
      throw vscode.FileSystemError.FileNotFound(uri);
    });
    return {
      type: stats.isDirectory
        ? vscode.FileType.Directory
        : vscode.FileType.File,
      ctime: stats.createdMs ?? stats.ctimeMs ?? Date.now(),
      mtime: stats.modifiedMs ?? stats.mtimeMs ?? Date.now(),
      size: stats.size,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const directory = decodeRemotePath(uri);
    const connector = await this.getConnector(uri);

    const entries = await connector.listDir(directory || "/");
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const connector = await this.getConnector(uri);
    return connector.readFile(decodeRemotePath(uri));
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const connector = await this.getConnector(uri);
    await connector.writeFile(decodeRemotePath(uri), content);
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Changed, uri },
    ]);
  }

  notifyDeleted(uri: vscode.Uri): void {
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri },
    ]);
  }

  notifyRestored(uri: vscode.Uri): void {
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Created, uri },
    ]);
  }

  notifyMoved(source: vscode.Uri, target: vscode.Uri): void {
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: source },
      { type: vscode.FileChangeType.Created, uri: target },
    ]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async rename(
    source: vscode.Uri,
    target: vscode.Uri,
    options: FileOperationOptions,
  ): Promise<void> {
    await this.fileOperations
      .rename(this.toRemotePath(source), this.toRemotePath(target), options)
      .catch(prepareThrowFileSystemError(target));
    this.notifyMoved(source, target);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.fileOperations
      .createDirectory(this.toRemotePath(uri))
      .catch(prepareThrowFileSystemError(uri));
    this.notifyRestored(uri);
  }

  async delete(
    uri: vscode.Uri,
    options: { recursive: boolean },
  ): Promise<void> {
    const connector = await this.getConnector(uri);
    await connector.deletePath(decodeRemotePath(uri));
    this.notifyDeleted(uri);
  }

  async copy(
    source: vscode.Uri,
    target: vscode.Uri,
    options: FileOperationOptions,
  ): Promise<void> {
    await this.fileOperations
      .copy(this.toRemotePath(source), this.toRemotePath(target), options)
      .catch(prepareThrowFileSystemError(target));

    this.notifyRestored(target);
  }
}

export class RemoteDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Definition> {
    const line = document.lineAt(position).text;
    const importMatch = line.match(
      /(?:from\s+['"](.+)['"]|import\s+['"](.+)['"])/,
    );
    if (!importMatch) {
      return undefined;
    }

    const resolved = importMatch[1] ?? importMatch[2];
    const connectionId = document.uri.authority;
    if (!connectionId) {
      return undefined;
    }

    const currentDir = dirname(decodeRemotePath(document.uri));
    const targetPath = resolveImportPath(currentDir, resolved);
    const targetUri = toVirtualUri(connectionId, targetPath);

    return new vscode.Location(targetUri, new vscode.Position(0, 0));
  }
}

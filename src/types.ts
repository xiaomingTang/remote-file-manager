export type RemoteKind = "connection" | "directory" | "file";

export interface DockerConnectionDef {
  id: string;
  container: string;
  path: string;
}

export interface SSHConnectionDef {
  id: string;
  host: string;
  port?: number;
  username: string;
  path: string;
}

export interface WSLConnectionDef {
  id: string;
  distribution: string;
  user?: string;
  path: string;
}

export type ConnectionConfigDef =
  DockerConnectionDef | SSHConnectionDef | WSLConnectionDef;

export type ConnectionKind = "docker" | "ssh" | "wsl";

export function resolveConnectionKind(
  item: unknown,
): ConnectionKind | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  const hasCommonFields =
    typeof record.id === "string" &&
    record.id.trim() !== "" &&
    typeof record.path === "string" &&
    record.path.trim() !== "";

  if (!hasCommonFields) {
    return undefined;
  }

  if (typeof record.container === "string" && record.container.trim() !== "") {
    return "docker";
  }

  if (
    typeof record.host === "string" &&
    record.host.trim() !== "" &&
    typeof record.username === "string" &&
    record.username.trim() !== ""
  ) {
    return "ssh";
  }

  if (
    typeof record.distribution === "string" &&
    record.distribution.trim() !== ""
  ) {
    return "wsl";
  }

  return undefined;
}

export interface ConnectionBucketByType {
  docker: DockerConnectionDef[];
  ssh: SSHConnectionDef[];
  wsl: WSLConnectionDef[];
}

export interface RemoteFileManagerConnectionsDocument {
  connections: ConnectionBucketByType;
}

export interface RemoteNode {
  readonly connectionId: string;
  readonly label: string;
  readonly path: string;
  readonly type: RemoteKind;
  readonly icon: string;
  readonly writable?: boolean;
}

export interface ConnectionHealth {
  isConnected: boolean;
  lastError?: string;
  lastCheckedAt?: number;
}

export interface RemoteEntry {
  name: string;
  isDirectory: boolean;
  writable: boolean;
}

export interface RemoteSearchOptions {
  searchValue: string;
  searchDirectory: string;
  limit?: number;
  excludePatterns?: string[];
}

export interface RemoteSearchResult {
  path: string;
  isDirectory: boolean;
}

export interface RemoteStat {
  isDirectory: boolean;
  size: number;
  writable: boolean;
  permission: string;
  permissionSymbolic: string;
  owner: string;
  group: string;
  linkTarget?: string;
  createdMs?: number;
  modifiedMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

export interface TransferOptions {
  isCancelled?: () => boolean;
}

export interface IRemoteConnector {
  listDir(path: string): Promise<RemoteEntry[]>;
  searchFiles(options: RemoteSearchOptions): Promise<RemoteSearchResult[]>;
  statPath(path: string): Promise<RemoteStat>;
  getDirectorySize(path: string): Promise<number>;
  readFile(path: string): Promise<Uint8Array>;
  downloadPath(
    remotePath: string,
    localPath: string,
    options?: TransferOptions,
  ): Promise<void>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  copyPath(sourcePath: string, targetPath: string): Promise<void>;
  movePath(sourcePath: string, targetPath: string): Promise<void>;
  deletePath(path: string): Promise<void>;
}

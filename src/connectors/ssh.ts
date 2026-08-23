import { spawn } from "child_process";
import {
  IRemoteConnector,
  RemoteEntry,
  RemoteStat,
  RemoteSearchOptions,
  RemoteSearchResult,
  TransferOptions,
  SSHConnectionDef,
  resolveConnectionKind,
  RemoteFileManagerConnectionsDocument,
} from "../types";
import { buildFindExcludeExpression, dirname, execFileAsync } from "../utils";
import { CustomError } from "../error/custom-error";
import {
  quoteShellArgument,
  remoteLoginShellArgs,
  scpConnectionArgs,
  sshConnectionArgs,
  sshDestination,
} from "./ssh-cli";

export class SSHConnectorFactory {
  static resolveDefinitions(
    document: RemoteFileManagerConnectionsDocument,
  ): SSHConnectionDef[] {
    const connections =
      document && typeof document === "object" && !Array.isArray(document)
        ? document.connections
        : undefined;
    const ssh =
      connections && typeof connections === "object"
        ? connections.ssh
        : undefined;

    return Array.isArray(ssh)
      ? ssh.filter(
          (item): item is SSHConnectionDef =>
            resolveConnectionKind(item) === "ssh",
        )
      : [];
  }

  static create(definition: SSHConnectionDef): SSHConnector {
    return new SSHConnector(definition);
  }
}

export class SSHConnector implements IRemoteConnector {
  private readonly definition: SSHConnectionDef;

  constructor(definition: SSHConnectionDef) {
    this.definition = definition;
  }

  private async execRemote(
    command: string,
    options?: { encoding?: "utf8" | "buffer"; maxBuffer?: number },
  ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    return execFileAsync(
      "ssh",
      [
        ...sshConnectionArgs(this.definition, { batchMode: true }),
        sshDestination(this.definition),
        "--",
        ...remoteLoginShellArgs(command),
      ],
      {
        maxBuffer: options?.maxBuffer ?? 50 * 1024 * 1024,
        encoding: options?.encoding ?? "utf8",
      },
    );
  }

  private async spawnRemoteStdin(
    command: string,
    content: Uint8Array,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ssh",
        [
          ...sshConnectionArgs(this.definition, { batchMode: true }),
          sshDestination(this.definition),
          "--",
          ...remoteLoginShellArgs(command),
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      const errors: Buffer[] = [];

      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(Buffer.concat(errors).toString("utf8")));
      });
      child.stdin.end(Buffer.from(content));
    });
  }

  private async copyWithScp(
    source: string,
    destination: string,
    options?: TransferOptions,
  ): Promise<void> {
    if (options?.isCancelled?.()) {
      throw new CustomError("downloadCanceled");
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "scp",
        [...scpConnectionArgs(this.definition), "-r", source, destination],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const errors: Buffer[] = [];
      let cancelled = false;
      const cancellationTimer = setInterval(() => {
        if (options?.isCancelled?.() && !cancelled) {
          cancelled = true;
          child.kill();
        }
      }, 100);

      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.on("error", (error) => {
        clearInterval(cancellationTimer);
        reject(error);
      });
      child.on("close", (code) => {
        clearInterval(cancellationTimer);
        if (cancelled) {
          reject(new CustomError("downloadCanceled"));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(Buffer.concat(errors).toString("utf8")));
        }
      });
    });
  }

  async listDir(path: string): Promise<RemoteEntry[]> {
    const target = path || "/";
    const result = await this.execRemote(
      `for entry in ${quoteShellArgument(target)}/* ${quoteShellArgument(target)}/.[!.]* ${quoteShellArgument(target)}/..?*; do
          [ -e "$entry" ] || continue
          name=\${entry##*/}
          if [ -d "$entry" ]; then
            kind=dir
          else
            kind=file
          fi
          if [ -w "$entry" ]; then
            writable=true
          else
            writable=false
          fi
          printf '%s\\t%s\\t%s\\n' "$kind" "$writable" "$name"
        done`,
    );

    return String(result.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [kind, writable, ...nameParts] = line.split("\t");
        return {
          name: nameParts.join("\t"),
          isDirectory: kind === "dir",
          writable: writable === "true",
        };
      });
  }

  async searchFiles({
    searchValue,
    searchDirectory,
    limit = 200,
    excludePatterns = [],
  }: RemoteSearchOptions): Promise<RemoteSearchResult[]> {
    const target = searchDirectory || "/";
    const pattern = `*${searchValue}*`;
    const result = await this.execRemote(
      `find ${quoteShellArgument(target)} ${buildFindExcludeExpression(target, excludePatterns)}\\( -type f -o -type d \\) -iname ${quoteShellArgument(pattern)} -printf '%y\\t%p\\n' 2>/dev/null | head -n ${Math.max(1, Math.floor(limit))}`,
      { maxBuffer: 10 * 1024 * 1024 },
    );

    return String(result.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf("\t");
        return {
          isDirectory: line.slice(0, separatorIndex) === "d",
          path: line.slice(separatorIndex + 1),
        };
      });
  }

  async statPath(path: string): Promise<RemoteStat> {
    const result = await this.execRemote(
      `target=${quoteShellArgument(path || "/")}
if [ -d "$target" ]; then
  kind=dir
  size=0
elif [ -f "$target" ]; then
  kind=file
  size=$(wc -c < "$target")
else
  exit 2
fi
if [ -w "$target" ]; then
  writable=true
else
  writable=false
fi
link_target=""
if [ -L "$target" ]; then
  link_target=$(readlink -f "$target" || true)
fi
printf '%s\t%s\t%s\t' "$kind" "$writable" "$size"
stat -c '%a\t%A\t%U\t%G\t%W\t%Y' "$target" | tr -d '\n'
printf '\t%s' "$link_target"`,
      { maxBuffer: 1024 * 1024 },
    );
    const [
      kind,
      writable,
      size,
      permission,
      permissionSymbolic,
      owner,
      group,
      created,
      modified,
      linkTarget,
    ] = String(result.stdout).trim().split("\t");
    return {
      isDirectory: kind === "dir",
      writable: writable === "true",
      size: Number(size) || 0,
      permission: permission || "---",
      permissionSymbolic:
        permissionSymbolic?.slice(1).match(/.../g)?.join(" ") || "--- --- ---",
      owner: owner || "unknown",
      group: group || "unknown",
      linkTarget: linkTarget || undefined,
      createdMs: Number(created) > 0 ? Number(created) * 1000 : undefined,
      modifiedMs: Number(modified) > 0 ? Number(modified) * 1000 : undefined,
    };
  }

  async getDirectorySize(path: string): Promise<number> {
    const result = await this.execRemote(
      `du -sb ${quoteShellArgument(path || "/")} | cut -f1`,
      { maxBuffer: 1024 * 1024 },
    );
    return Number(String(result.stdout).trim()) || 0;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const result = await this.execRemote(`cat ${quoteShellArgument(path)}`, {
      encoding: "buffer",
    });
    return Buffer.from(result.stdout as Buffer);
  }

  async downloadPath(
    remotePath: string,
    localPath: string,
    options?: TransferOptions,
  ): Promise<void> {
    await this.copyWithScp(
      `${sshDestination(this.definition)}:${remotePath}`,
      localPath,
      options,
    );
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await this.spawnRemoteStdin(
      `mkdir -p ${quoteShellArgument(dirname(path))} && cat > ${quoteShellArgument(path)}`,
      content,
    );
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.createDirectory(dirname(remotePath));
    await this.copyWithScp(
      localPath,
      `${sshDestination(this.definition)}:${remotePath}`,
    );
  }

  async createDirectory(path: string): Promise<void> {
    await this.execRemote(`mkdir -p ${quoteShellArgument(path)}`, {
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  async createFile(path: string): Promise<void> {
    await this.execRemote(
      `mkdir -p ${quoteShellArgument(dirname(path))} && touch ${quoteShellArgument(path)}`,
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }

  async copyPath(sourcePath: string, targetPath: string): Promise<void> {
    if (sourcePath === targetPath) {
      return;
    }

    await this.execRemote(
      `mkdir -p ${quoteShellArgument(dirname(targetPath))} && cp -a ${quoteShellArgument(sourcePath)} ${quoteShellArgument(targetPath)}`,
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }

  async movePath(sourcePath: string, targetPath: string): Promise<void> {
    if (sourcePath === targetPath) {
      return;
    }

    await this.execRemote(
      `mkdir -p ${quoteShellArgument(dirname(targetPath))} && mv ${quoteShellArgument(sourcePath)} ${quoteShellArgument(targetPath)}`,
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }

  async deletePath(path: string): Promise<void> {
    const targetPath = path || "/";
    if (targetPath === "/") {
      throw new CustomError("cannotDeleteRoot");
    }

    await this.execRemote(`rm -rf ${quoteShellArgument(targetPath)}`, {
      maxBuffer: 20 * 1024 * 1024,
    });
  }
}

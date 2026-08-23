import * as fs from "fs/promises";
import { spawn } from "child_process";
import { execFileAsync } from "../utils";
import { buildFindExcludeExpression, dirname } from "../utils";
import {
  IRemoteConnector,
  RemoteEntry,
  RemoteSearchOptions,
  RemoteSearchResult,
  RemoteStat,
  TransferOptions,
  WSLConnectionDef,
  resolveConnectionKind,
  RemoteFileManagerConnectionsDocument,
} from "../types";
import { CustomError } from "../error/custom-error";
import { quoteShellArgument } from "./ssh-cli";

export class WSLConnectorFactory {
  static resolveDefinitions(
    document: RemoteFileManagerConnectionsDocument,
  ): WSLConnectionDef[] {
    const connections =
      document && typeof document === "object" && !Array.isArray(document)
        ? document.connections
        : undefined;
    const wsl =
      connections && typeof connections === "object"
        ? connections.wsl
        : undefined;

    return Array.isArray(wsl)
      ? wsl.filter(
          (item): item is WSLConnectionDef =>
            resolveConnectionKind(item) === "wsl",
        )
      : [];
  }

  static create(definition: WSLConnectionDef): WSLConnector {
    return new WSLConnector(definition);
  }
}

export class WSLConnector implements IRemoteConnector {
  private readonly definition: WSLConnectionDef;

  constructor(definition: WSLConnectionDef) {
    this.definition = definition;
  }

  private shellArgs(): string[] {
    return [
      "-d",
      this.definition.distribution,
      ...(this.definition.user ? ["-u", this.definition.user] : []),
      "--",
      "sh",
      "-s",
    ];
  }

  private async execLinux(
    command: string,
    options?: { encoding?: "utf8" | "buffer"; maxBuffer?: number },
  ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn("wsl.exe", this.shellArgs(), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputSize = 0;
      const maxBuffer = options?.maxBuffer ?? 50 * 1024 * 1024;

      child.stdout.on("data", (chunk: Buffer) => {
        outputSize += chunk.length;
        if (outputSize <= maxBuffer) stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (outputSize > maxBuffer) {
          reject(new Error("WSL command output exceeded the maximum size."));
          return;
        }
        if (code !== 0) {
          reject(new Error(Buffer.concat(stderr).toString("utf8")));
          return;
        }
        const output = Buffer.concat(stdout);
        resolve({
          stdout:
            options?.encoding === "buffer" ? output : output.toString("utf8"),
          stderr:
            options?.encoding === "buffer"
              ? Buffer.concat(stderr)
              : Buffer.concat(stderr).toString("utf8"),
        });
      });
      child.stdin.end(command);
    });
  }

  async listDir(path: string): Promise<RemoteEntry[]> {
    const target = path || "/";
    const result = await this.execLinux(
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
    const result = await this.execLinux(
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
    const result = await this.execLinux(
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
printf '%s\\t%s\\t%s\\t' "$kind" "$writable" "$size"
  stat -c '%a|%A|%U|%G|%W|%Y' "$target" | tr -d '\n'
printf '\\t%s' "$link_target"`,
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
    ] = String(result.stdout).trim().split(/[\t|]/);
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
    const result = await this.execLinux(
      `du -sb ${quoteShellArgument(path || "/")} | cut -f1`,
      { maxBuffer: 1024 * 1024 },
    );
    return Number(String(result.stdout).trim()) || 0;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const result = await this.execLinux(`cat ${quoteShellArgument(path)}`, {
      encoding: "buffer",
    });
    return Buffer.from(result.stdout as Buffer);
  }

  async downloadPath(
    remotePath: string,
    localPath: string,
    options?: TransferOptions,
  ): Promise<void> {
    if (options?.isCancelled?.()) {
      throw new CustomError("downloadCanceled");
    }

    const stats = await this.statPath(remotePath);
    if (stats.isDirectory) {
      await fs.mkdir(localPath, { recursive: true });
      for (const entry of await this.listDir(remotePath)) {
        if (options?.isCancelled?.()) {
          throw new CustomError("downloadCanceled");
        }
        await this.downloadPath(
          `${remotePath.replace(/\/+$/, "")}/${entry.name}`,
          `${localPath}/${entry.name}`,
          options,
        );
      }
      return;
    }

    await fs.writeFile(localPath, await this.readFile(remotePath));
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "wsl.exe",
        [
          "-d",
          this.definition.distribution,
          ...(this.definition.user ? ["-u", this.definition.user] : []),
          "--",
          "sh",
          "-c",
          `mkdir -p ${quoteShellArgument(dirname(path))} && cat > ${quoteShellArgument(path)}`,
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      const errors: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.on("error", reject);
      child.on("close", (code: number) =>
        code === 0
          ? resolve()
          : reject(new Error(Buffer.concat(errors).toString("utf8"))),
      );
      child.stdin.end(Buffer.from(content));
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.createDirectory(dirname(remotePath));
    await this.writeFile(remotePath, await fs.readFile(localPath));
  }

  async createDirectory(path: string): Promise<void> {
    await this.execLinux(`mkdir -p ${quoteShellArgument(path)}`);
  }

  async createFile(path: string): Promise<void> {
    await this.execLinux(
      `mkdir -p ${quoteShellArgument(dirname(path))} && touch ${quoteShellArgument(path)}`,
    );
  }

  async copyPath(sourcePath: string, targetPath: string): Promise<void> {
    if (sourcePath === targetPath) return;
    await this.execLinux(
      `mkdir -p ${quoteShellArgument(dirname(targetPath))} && cp -a ${quoteShellArgument(sourcePath)} ${quoteShellArgument(targetPath)}`,
    );
  }

  async movePath(sourcePath: string, targetPath: string): Promise<void> {
    if (sourcePath === targetPath) return;
    await this.execLinux(
      `mkdir -p ${quoteShellArgument(dirname(targetPath))} && mv ${quoteShellArgument(sourcePath)} ${quoteShellArgument(targetPath)}`,
    );
  }

  async deletePath(path: string): Promise<void> {
    const targetPath = path || "/";
    if (targetPath === "/") {
      throw new CustomError("cannotDeleteRoot");
    }
    await this.execLinux(`rm -rf ${quoteShellArgument(targetPath)}`);
  }

  getTerminalCommand(cwd: string): { shellPath: string; shellArgs: string[] } {
    const workingDirectory = cwd || "/";
    return {
      shellPath: "wsl.exe",
      shellArgs: [
        "-d",
        this.definition.distribution,
        ...(this.definition.user ? ["-u", this.definition.user] : []),
        "--cd",
        workingDirectory,
        "--",
        "sh",
        "-il",
      ],
    };
  }
}

import { spawn } from "child_process";
import { execFileAsync } from "../utils";
import { buildFindExcludeExpression, dirname } from "../utils";
import {
  DockerConnectionDef,
  IRemoteConnector,
  RemoteEntry,
  RemoteStat,
  RemoteSearchOptions,
  RemoteSearchResult,
  TransferOptions,
  resolveConnectionKind,
  RemoteFileManagerConnectionsDocument,
} from "../types";
import { CustomError } from "../error/custom-error";

export class DockerConnectorFactory {
  static resolveDefinitions(
    document: RemoteFileManagerConnectionsDocument,
  ): DockerConnectionDef[] {
    const connections =
      document && typeof document === "object" && !Array.isArray(document)
        ? document.connections
        : undefined;
    const docker =
      connections && typeof connections === "object"
        ? connections.docker
        : undefined;

    return Array.isArray(docker)
      ? docker.filter(
          (item): item is DockerConnectionDef =>
            resolveConnectionKind(item) === "docker",
        )
      : [];
  }

  static create(definition: DockerConnectionDef): DockerConnector {
    return new DockerConnector(definition.container);
  }
}

export class DockerConnector implements IRemoteConnector {
  private readonly container: string;

  constructor(container: string) {
    this.container = container;
  }

  private quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  async listDir(path: string): Promise<RemoteEntry[]> {
    const target = path || "/";
    const result = await execFileAsync(
      "docker",
      [
        "exec",
        this.container,
        "sh",
        "-lc",
        `for entry in ${this.quote(target)}/* ${this.quote(target)}/.[!.]* ${this.quote(target)}/..?*; do
          [ -e "$entry" ] || [ -L "$entry" ] || continue
          name=\${entry##*/}
          is_link=false
          broken=false
          if [ -L "$entry" ]; then
            is_link=true
            [ -e "$entry" ] || broken=true
          fi
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
          printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$kind" "$writable" "$is_link" "$broken" "$name"
        done`,
      ],
      { maxBuffer: 50 * 1024 * 1024 },
    );

    return String(result.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [
          kind,
          writable,
          isSymbolicLink,
          isBrokenSymbolicLink,
          ...nameParts
        ] = line.split("\t");
        return {
          name: nameParts.join("\t"),
          isDirectory: kind === "dir",
          writable: writable === "true",
          isSymbolicLink: isSymbolicLink === "true",
          isBrokenSymbolicLink: isBrokenSymbolicLink === "true",
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
    const result = await execFileAsync(
      "docker",
      [
        "exec",
        this.container,
        "sh",
        "-lc",
        `find ${this.quote(target)} ${buildFindExcludeExpression(target, excludePatterns)}\\( -type f -o -type d -o -type l \\) -iname ${this.quote(pattern)} -printf '%y\\t%p\\n' 2>/dev/null | head -n ${Math.max(1, Math.floor(limit))}`,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    return String(result.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf("\t");
        const kind = line.slice(0, separatorIndex);
        return {
          isDirectory: kind === "d",
          path: line.slice(separatorIndex + 1),
          isSymbolicLink: kind === "l",
        };
      });
  }

  async statPath(path: string): Promise<RemoteStat> {
    const result = await execFileAsync(
      "docker",
      [
        "exec",
        this.container,
        "sh",
        "-lc",
        `target=${this.quote(path || "/")}
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
      ],
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
    const result = await execFileAsync(
      "docker",
      [
        "exec",
        this.container,
        "sh",
        "-lc",
        `du -sb ${this.quote(path || "/")} | cut -f1`,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    return Number(String(result.stdout).trim()) || 0;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const result = await execFileAsync(
      "docker",
      ["exec", this.container, "sh", "-lc", `cat ${this.quote(path)}`],
      { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" },
    );
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

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "docker",
        ["cp", `${this.container}:${remotePath}`, localPath],
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

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const command = `mkdir -p ${this.quote(dirname(path))} && cat > ${this.quote(path)}`;
    await new Promise<void>((resolve, reject) => {
      const process = spawn(
        "docker",
        ["exec", "-i", this.container, "sh", "-lc", command],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      const errors: Buffer[] = [];

      process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      process.on("error", reject);
      process.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(Buffer.concat(errors).toString("utf8")));
      });
      process.stdin.end(Buffer.from(content));
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.createDirectory(dirname(remotePath));
    await execFileAsync(
      "docker",
      ["cp", localPath, `${this.container}:${remotePath}`],
      { maxBuffer: 50 * 1024 * 1024 },
    );
  }

  async createDirectory(path: string): Promise<void> {
    await execFileAsync(
      "docker",
      ["exec", this.container, "sh", "-lc", `mkdir -p ${this.quote(path)}`],
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }

  async createFile(path: string): Promise<void> {
    await execFileAsync(
      "docker",
      [
        "exec",
        this.container,
        "sh",
        "-lc",
        `mkdir -p ${this.quote(dirname(path))} && touch ${this.quote(path)}`,
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }

  async copyPath(sourcePath: string, targetPath: string): Promise<void> {
    if (sourcePath === targetPath) {
      return;
    }

    await execFileAsync(
      "docker",
      [
        "exec",
        this.container,
        "sh",
        "-lc",
        `mkdir -p ${this.quote(dirname(targetPath))} && cp -a ${this.quote(sourcePath)} ${this.quote(targetPath)}`,
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }

  async movePath(sourcePath: string, targetPath: string): Promise<void> {
    if (sourcePath === targetPath) {
      return;
    }

    await execFileAsync(
      "docker",
      [
        "exec",
        this.container,
        "sh",
        "-lc",
        `mkdir -p ${this.quote(dirname(targetPath))} && mv ${this.quote(sourcePath)} ${this.quote(targetPath)}`,
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }

  async deletePath(path: string): Promise<void> {
    await execFileAsync(
      "docker",
      ["exec", this.container, "sh", "-lc", `rm -rf ${this.quote(path)}`],
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }
}

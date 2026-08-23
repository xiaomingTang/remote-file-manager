import { execFile } from "child_process";
import { promisify } from "util";
import { CustomError } from "./error/custom-error";
import { REMOTE_FILE_MANAGER_TRASH_ROOT } from "./constants";

export const execFileAsync = promisify(execFile);

function getVsCodeApi(): typeof import("vscode") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("vscode") as typeof import("vscode");
  } catch {
    throw new CustomError("extensionOnly");
  }
}

export function normalizeRemotePath(remotePath: string): string {
  const normalized = remotePath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function joinPath(base: string, name: string): string {
  const combined = `${base.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
  return normalizeRemotePath(combined);
}

export function dirname(value: string): string {
  const normalized = normalizeRemotePath(value);
  if (normalized === "/") {
    return "/";
  }

  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

export function basename(value: string): string {
  const normalized = normalizeRemotePath(value);
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "/";
}

function quoteFindPattern(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildFindExcludeExpression(
  searchDirectory: string,
  excludePatterns: string[] = [],
): string {
  const target =
    normalizeRemotePath(searchDirectory || "/").replace(/\/+$/, "") || "/";
  const patterns = excludePatterns
    .map((pattern) => pattern.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean)
    .map((pattern) => {
      const pathPattern = pattern.startsWith("/")
        ? pattern
        : target === "/"
          ? `/${pattern}`
          : `${target}/${pattern}`;
      return quoteFindPattern(pathPattern);
    });

  if (patterns.length === 0) {
    return "";
  }

  return `\\( ${patterns.map((pattern) => `-path ${pattern}`).join(" -o ")} \\) -prune -o `;
}

export function resolveTrashPath(
  remotePath: string,
  timestamp: number,
): string {
  return joinPath(
    joinPath(REMOTE_FILE_MANAGER_TRASH_ROOT, String(timestamp)),
    basename(remotePath),
  );
}

export function shouldCleanupTrash(
  lastDeleteAt: number | undefined,
  currentDeleteAt: number,
  maxAgeMs = 180_000,
): boolean {
  return (
    lastDeleteAt !== undefined && currentDeleteAt - lastDeleteAt > maxAgeMs
  );
}

export function decodeRemotePath(uri: import("vscode").Uri): string {
  const decoded = decodeURIComponent(uri.path || "/");
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

export function canDropIntoTarget(
  target?: { type?: string; connectionId?: string },
  _sourceConnectionId?: string,
): boolean {
  if (!target) {
    return true;
  }

  return (
    target.type === "directory" ||
    target.type === "connection" ||
    target.type === "file"
  );
}

export function resolveDropTargetPath(
  sourcePath: string,
  targetPath: string,
): string {
  const normalizedSource = normalizeRemotePath(sourcePath);
  const normalizedTarget = normalizeRemotePath(targetPath);
  const destinationDirectory =
    normalizedTarget === "/" ? "/" : normalizedTarget;
  return joinPath(destinationDirectory, basename(normalizedSource));
}

export function resolvePasteTargetPath(
  sourcePath: string,
  targetPath: string,
): string {
  return resolveDropTargetPath(sourcePath, targetPath);
}

export function isSameRemoteNode(
  left?: { connectionId: string; path: string; type: string },
  right?: { connectionId: string; path: string; type: string },
): boolean {
  return (
    !!left &&
    !!right &&
    left.connectionId === right.connectionId &&
    left.path === right.path &&
    left.type === right.type
  );
}

export function resolveTreeCommandNodes<
  T extends { connectionId: string; path: string; type: string },
>(node: T | undefined, selection: readonly T[]): T[] {
  if (node && !selection.some((item) => isSameRemoteNode(item, node))) {
    return [node];
  }

  if (selection.length > 0) {
    return [...selection];
  }

  return node ? [node] : [];
}

export function resolveTreeCommandNode<
  T extends { connectionId: string; path: string; type: string },
>(node: T | undefined, selection: readonly T[]): T | undefined {
  return node ?? selection[0];
}

const ITEM_NAME_SUMMARY_LIMIT = 2;

export function formatItemNames(
  items: readonly string[],
  limit = ITEM_NAME_SUMMARY_LIMIT,
): string {
  const names = items.map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) {
    return "";
  }

  const visible = names.slice(0, limit).join(", ");
  return names.length > limit ? `${visible}...` : visible;
}

export function formatItemNameSummary(
  items: readonly { label?: string; path?: string }[],
  limit = ITEM_NAME_SUMMARY_LIMIT,
): string {
  return formatItemNames(
    items.map((item) => item.label || basename(item.path ?? "")),
    limit,
  );
}

export function withItemNames(
  message: string,
  items: readonly { label?: string; path?: string }[],
): string {
  const summary = formatItemNameSummary(items);
  return summary ? `${message}: ${summary}` : message;
}

export function resolveUploadTargetPath(
  fileName: string,
  targetPath: string,
): string {
  const normalizedTarget = normalizeRemotePath(targetPath);
  return joinPath(normalizedTarget === "/" ? "/" : normalizedTarget, fileName);
}

export function toVirtualUri(
  connectionId: string,
  remotePath: string,
): import("vscode").Uri {
  const vscode = getVsCodeApi();
  const normalized = normalizeRemotePath(remotePath);
  return vscode.Uri.from({
    scheme: "remote-file-manager",
    authority: connectionId,
    path: normalized,
  });
}

export function resolveImportPath(
  currentDir: string,
  specifier: string,
): string {
  if (specifier.startsWith(".")) {
    return joinPath(currentDir, specifier).replace(/\/index$/, "");
  }

  return joinPath(currentDir, specifier);
}

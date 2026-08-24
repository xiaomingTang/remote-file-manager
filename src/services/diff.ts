import * as vscode from "vscode";
import { ConnectionManager } from "../config";
import { RemoteNode } from "../types";
import { toVirtualUri } from "../utils";

const DIFF_SCHEME = "remote-file-manager-diff";

function decodeTextContent(content: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const hasBinaryControlCharacter = [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 0 ||
        (codePoint < 0x20 &&
          codePoint !== 0x09 &&
          codePoint !== 0x0a &&
          codePoint !== 0x0d)
      );
    });
    return hasBinaryControlCharacter ? undefined : text;
  } catch {
    return undefined;
  }
}

export class RemoteDiffManager
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly cachedContents = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[];

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly connectionManager: ConnectionManager) {
    this.disposables = [
      this.onDidChangeEmitter,
      vscode.window.tabGroups.onDidChangeTabs(() => this.cleanupUnused()),
    ];
  }

  async open(node: RemoteNode): Promise<void> {
    const remoteUri = toVirtualUri(node.connectionId, node.path);
    const cacheUri = this.getCacheUri(node);
    const cacheKey = cacheUri.toString();

    if (!this.cachedContents.has(cacheKey)) {
      const connector = this.connectionManager.getConnectorOrThrow(
        node.connectionId,
      );
      const savedContent = await connector.readFile(node.path);
      const textContent = decodeTextContent(savedContent);
      if (textContent === undefined) {
        throw new Error(`The file "${node.path}" is not a UTF-8 text file.`);
      }
      this.cachedContents.set(cacheKey, textContent);
    }

    await vscode.commands.executeCommand(
      "vscode.diff",
      cacheUri,
      remoteUri,
      `${node.label} (Original) <-> ${node.label}`,
      { preview: false },
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.cachedContents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.cachedContents.clear();
  }

  private getCacheUri(node: RemoteNode): vscode.Uri {
    return vscode.Uri.from({
      scheme: DIFF_SCHEME,
      authority: encodeURIComponent(node.connectionId),
      path: node.path,
    });
  }

  private cleanupUnused(): void {
    const activeOriginalUris = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          activeOriginalUris.add(tab.input.original.toString());
        }
      }
    }

    for (const cacheKey of this.cachedContents.keys()) {
      if (!activeOriginalUris.has(cacheKey)) {
        this.cachedContents.delete(cacheKey);
      }
    }
  }
}

export { DIFF_SCHEME };

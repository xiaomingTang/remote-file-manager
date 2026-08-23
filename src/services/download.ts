import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { IRemoteConnector, RemoteNode } from "../types";
import { CustomError } from "../error/custom-error";
import { withItemNames } from "../utils";

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function downloadNode(
  node: RemoteNode,
  connector: IRemoteConnector,
): Promise<void> {
  await downloadNodes([node], connector);
}

export async function downloadNodes(
  nodes: readonly RemoteNode[],
  connector: IRemoteConnector,
): Promise<void> {
  const destinations = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Download Here",
  });
  if (!destinations || destinations.length === 0) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: withItemNames(`Downloading ${nodes.length} item(s)`, nodes),
      cancellable: true,
    },
    async (_progress, cancellationToken) => {
      for (const node of nodes) {
        if (cancellationToken.isCancellationRequested) {
          throw new CustomError("downloadCanceled");
        }

        let targetName = node.label;
        let targetPath = path.join(destinations[0].fsPath, targetName);
        if (await exists(targetPath)) {
          const choice = await vscode.window.showWarningMessage(
            `A local item named "${targetName}" already exists.`,
            { modal: true },
            "Overwrite",
            "Rename",
            "Cancel",
          );

          if (choice === "Cancel" || !choice) {
            return;
          }

          if (choice === "Rename") {
            const renamed = await vscode.window.showInputBox({
              prompt: "Download as",
              value: targetName,
              ignoreFocusOut: true,
            });
            if (!renamed || !renamed.trim()) {
              return;
            }
            targetName = renamed.trim();
            targetPath = path.join(destinations[0].fsPath, targetName);
            if (await exists(targetPath)) {
              void vscode.window.showErrorMessage(
                `A local item named "${targetName}" already exists.`,
              );
              return;
            }
          } else {
            await fs.rm(targetPath, { recursive: true, force: true });
          }
        }

        try {
          await connector.downloadPath(node.path, targetPath, {
            isCancelled: () => cancellationToken.isCancellationRequested,
          });
        } catch (error) {
          await fs.rm(targetPath, { recursive: true, force: true });
          throw error;
        }
      }
    },
  );

  void vscode.window.showInformationMessage(
    withItemNames(`Downloaded ${nodes.length} item(s)`, nodes),
  );
}

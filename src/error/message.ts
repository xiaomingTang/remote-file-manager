export const MSG = {
  unknownError: "An unknown error occurred.",
  renameCanceled: "Rename operation was canceled.",
  nameNotChanged: "Name was not changed.",
  nameAlreadyExists: "A file or folder with the same name already exists.",
  noConnector: "No connector available for this connection.",
  extensionOnly:
    "This VS Code-specific helper can only be used from the extension host.",
  downloadCanceled: "Download operation was canceled.",
  terminalConnectionCanceled: "Terminal connection was canceled.",
  cannotMoveAcrossConnections:
    "Cannot move files across different connections.",
  cannotDeleteRoot: "Cannot delete the root folder.",
  noConnectorSelected: "No connector selected.",
  connectionUnavailable: `The connection "{{connectionId}}" is unavailable.`,
  connectorNotFound: `The connector for connection "{{connectionId}}" was not found.`,
};

export function msg(
  error: unknown,
  fallbackMessage = MSG.unknownError,
): string {
  return error instanceof Error ? error.message : fallbackMessage;
}

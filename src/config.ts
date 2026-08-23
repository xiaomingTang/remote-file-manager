import * as vscode from "vscode";
import { msg } from "./error/message";
import { CustomError } from "./error/custom-error";
import {
  ConnectionConfigDef,
  IRemoteConnector,
  ConnectionHealth,
  RemoteFileManagerConnectionsDocument,
} from "./types";
import { createConnector, getConnectionTargetName } from "./connectors/factory";
import { DockerConnectorFactory } from "./connectors/docker";
import { SSHConnectorFactory } from "./connectors/ssh";
import { WSLConnectorFactory } from "./connectors/wsl";
import { REMOTE_FILE_MANAGER_CONNECTIONS_CONFIG_KEY } from "./constants";

export class ConnectionManager implements vscode.Disposable {
  private readonly configurationChangeSubscription: vscode.Disposable;
  private connectionDocument: RemoteFileManagerConnectionsDocument;
  private readonly healthById = new Map<string, ConnectionHealth>();
  private readonly connectorsById = new Map<
    string,
    { definitionKey: string; connector: IRemoteConnector }
  >();

  constructor() {
    this.connectionDocument = this.readConnectionDocument();
    this.configurationChangeSubscription =
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          !event.affectsConfiguration(
            REMOTE_FILE_MANAGER_CONNECTIONS_CONFIG_KEY,
          )
        ) {
          return;
        }

        this.connectionDocument = this.readConnectionDocument();
        this.connectorsById.clear();
      });
  }

  private readConnectionDocument(): RemoteFileManagerConnectionsDocument {
    return vscode.workspace
      .getConfiguration()
      .get<RemoteFileManagerConnectionsDocument>(
        REMOTE_FILE_MANAGER_CONNECTIONS_CONFIG_KEY,
        {
          connections: {
            docker: [],
            ssh: [],
            wsl: [],
          },
        },
      );
  }

  dispose(): void {
    this.configurationChangeSubscription.dispose();
  }

  getDefinitions(): ConnectionConfigDef[] {
    return [
      ...DockerConnectorFactory.resolveDefinitions(this.connectionDocument),
      ...SSHConnectorFactory.resolveDefinitions(this.connectionDocument),
      ...WSLConnectorFactory.resolveDefinitions(this.connectionDocument),
    ];
  }

  getDefinition(connectionId: string): ConnectionConfigDef | undefined {
    return this.getDefinitions().find((item) => item.id === connectionId);
  }

  getHealth(connectionId: string): ConnectionHealth {
    return (
      this.healthById.get(connectionId) ?? {
        isConnected: false,
      }
    );
  }

  setHealth(connectionId: string, health: ConnectionHealth): void {
    this.healthById.set(connectionId, health);
  }

  async validateConnection(connectionId: string): Promise<boolean> {
    const definition = this.getDefinition(connectionId);
    if (!definition) {
      return false;
    }

    try {
      const connector = this.getConnectorOrThrow(connectionId);

      await connector.listDir(definition.path ?? "/");
      this.setHealth(connectionId, {
        isConnected: true,
        lastCheckedAt: Date.now(),
      });
      return true;
    } catch (error) {
      this.connectorsById.delete(connectionId);
      const message = msg(error, "Unknown connection error");
      const connectionName = getConnectionTargetName(definition);
      void vscode.window.showErrorMessage(
        `Connection failed for "${connectionName}": ${message}`,
      );
      this.setHealth(connectionId, {
        isConnected: false,
        lastCheckedAt: Date.now(),
        lastError: message,
      });

      return false;
    }
  }

  async validateConnectionOrThrow(connectionId: string): Promise<void> {
    const isValid = await this.validateConnection(connectionId);
    if (!isValid) {
      throw new CustomError("connectionUnavailable").v({ connectionId });
    }
  }

  getConnector(connectionId: string): IRemoteConnector | undefined {
    const definition = this.getDefinition(connectionId);
    if (!definition) {
      this.connectorsById.delete(connectionId);
      return undefined;
    }

    const definitionKey = JSON.stringify(definition);
    const cached = this.connectorsById.get(connectionId);
    if (cached?.definitionKey === definitionKey) {
      return cached.connector;
    }

    const connector = createConnector(definition);
    if (!connector) {
      return undefined;
    }

    this.connectorsById.set(connectionId, { definitionKey, connector });
    return connector;
  }

  getConnectorOrThrow(connectionId: string): IRemoteConnector {
    const connector = this.getConnector(connectionId);
    if (!connector) {
      throw new CustomError("noConnector").v({ connectionId });
    }
    return connector;
  }
}

export async function manageConnections(): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    REMOTE_FILE_MANAGER_CONNECTIONS_CONFIG_KEY,
  );
}

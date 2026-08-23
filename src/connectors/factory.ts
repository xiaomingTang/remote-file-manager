import {
  IRemoteConnector,
  ConnectionConfigDef,
  DockerConnectionDef,
  SSHConnectionDef,
  WSLConnectionDef,
  resolveConnectionKind,
} from "../types";
import { DockerConnectorFactory } from "./docker";
import { SSHConnectorFactory } from "./ssh";
import { WSLConnectorFactory } from "./wsl";

export function createConnector(
  definition: ConnectionConfigDef,
): IRemoteConnector | undefined {
  switch (resolveConnectionKind(definition)) {
    case "docker":
      return DockerConnectorFactory.create(definition as DockerConnectionDef);
    case "ssh":
      return SSHConnectorFactory.create(definition as SSHConnectionDef);
    case "wsl":
      return WSLConnectorFactory.create(definition as WSLConnectionDef);
    default:
      return undefined;
  }
}

export function getConnectionTargetName(
  definition: ConnectionConfigDef,
): string {
  const kind = resolveConnectionKind(definition);
  switch (kind) {
    case "docker":
      return (definition as DockerConnectionDef).container;
    case "ssh":
      return (definition as SSHConnectionDef).host;
    case "wsl":
      return (definition as WSLConnectionDef).distribution;
    default:
      throw new Error(`Unknown connection kind: ${kind}`);
  }
}

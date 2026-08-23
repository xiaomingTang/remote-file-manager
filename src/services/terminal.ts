import * as vscode from "vscode";
import {
  interactiveLoginShellCommand,
  sshConnectionArgs,
  sshDestination,
} from "../connectors/ssh-cli";
import {
  ConnectionConfigDef,
  DockerConnectionDef,
  SSHConnectionDef,
  WSLConnectionDef,
  resolveConnectionKind,
} from "../types";
import { WSLConnector } from "../connectors/wsl";

export function createRemoteTerminal(
  definition: ConnectionConfigDef,
  cwd = "/",
): vscode.Terminal {
  const workingDirectory = cwd || "/";
  const name = `Remote: ${definition.id}`;
  const connectionKind = resolveConnectionKind(definition);

  if (connectionKind === "docker") {
    const { container } = definition as DockerConnectionDef;
    return vscode.window.createTerminal({
      name,
      shellPath: "docker",
      shellArgs: [
        "exec",
        "-it",
        "-w",
        workingDirectory,
        "-e",
        "TERM=xterm-256color",
        container,
        "sh",
        "-lc",
        interactiveLoginShellCommand(workingDirectory),
      ],
    });
  }

  if (connectionKind === "ssh") {
    const sshDefinition = definition as SSHConnectionDef;
    const shellArgs = [
      "-t",
      ...sshConnectionArgs(sshDefinition),
      sshDestination(sshDefinition),
      interactiveLoginShellCommand(workingDirectory),
    ];

    return vscode.window.createTerminal({
      name,
      shellPath: "ssh",
      shellArgs,
    });
  }

  if (connectionKind === "wsl") {
    const terminal = new WSLConnector(
      definition as WSLConnectionDef,
    ).getTerminalCommand(workingDirectory);
    return vscode.window.createTerminal({ name, ...terminal });
  }

  throw new Error(`Unknown connection type: ${connectionKind}`);
}

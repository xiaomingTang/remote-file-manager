import { SSHConnectionDef } from "../types";

export function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function remoteLoginShellArgs(command: string): string[] {
  // OpenSSH joins remote argv with spaces and runs the result via the login
  // shell. Quote the script so `sh -lc` still receives a single argument.
  return ["sh", "-lc", quoteShellArgument(command)];
}

export function sshDestination(definition: SSHConnectionDef): string {
  return `${definition.username}@${definition.host}`;
}

export function interactiveLoginShellCommand(workingDirectory: string): string {
  const cwd = workingDirectory || "/";
  return `cd ${quoteShellArgument(cwd)} && export TERM="\${TERM:-xterm-256color}" && exec "\${SHELL:-/bin/bash}" -il`;
}

export function sshConnectionArgs(
  definition: SSHConnectionDef,
  options?: { batchMode?: boolean },
): string[] {
  const args: string[] = [];
  if (options?.batchMode) {
    args.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=15");
  }
  if (definition.port) {
    args.push("-p", String(definition.port));
  }
  return args;
}

export function scpConnectionArgs(definition: SSHConnectionDef): string[] {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
  if (definition.port) {
    args.push("-P", String(definition.port));
  }
  return args;
}

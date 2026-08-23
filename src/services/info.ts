import ejs from "ejs";
import infoTemplate from "./info.ejs";
import { RemoteNode, RemoteStat } from "../types";

interface InfoLink {
  text: string;
  uri?: string;
}

interface InfoTemplateData {
  icon: string;
  nodeLabel: string;
  path: InfoLink[];
  size: { value: string; exact?: string };
  permission: string;
  owner: { user: string; group: string };
  created: string;
  modified: string;
}

interface CreateInfoHtmlOptions {
  node: RemoteNode;
  stats: RemoteStat;
  sizeText?: string;
  linkTargetUri?: string;
  currentPathUri?: string;
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} bytes`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let unit = units[0];
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024 || nextUnit === units[units.length - 1]) {
      break;
    }
  }
  return `${Number(value.toFixed(1))} ${unit}`;
}

function formatExactSize(size: number): string {
  return `${size.toLocaleString("en-US")} bytes`;
}

function formatDate(timestamp?: number): string {
  return timestamp
    ? new Date(timestamp).toLocaleString("sv-SE")
    : "Unavailable";
}

function safeUri(uri?: string): string | undefined {
  if (!uri) {
    return undefined;
  }
  try {
    return new URL(uri).protocol === "remote-file-manager:" ? uri : undefined;
  } catch {
    return undefined;
  }
}

function pathLink(path: string, uri?: string): InfoLink {
  return { text: path, uri: safeUri(uri) };
}

export function getInfoTitle(name: string): string {
  const limit = 48;
  return name.length > limit ? `${name.slice(0, limit - 3)}...` : name;
}

export function createInfoHtml({
  node,
  stats,
  sizeText,
  linkTargetUri,
  currentPathUri,
}: CreateInfoHtmlOptions): string {
  const data: InfoTemplateData = {
    icon: node.type === "directory" ? "&#128193;" : "&#128196;",
    nodeLabel: node.label,
    path: stats.linkTarget
      ? [
          pathLink(node.path, currentPathUri),
          pathLink(stats.linkTarget, linkTargetUri),
        ]
      : [pathLink(node.path, currentPathUri)],
    size: {
      value: sizeText ?? formatBytes(stats.size),
      exact: sizeText ? undefined : formatExactSize(stats.size),
    },
    permission: `${stats.permission} / ${stats.permissionSymbolic}`,
    owner: { user: stats.owner, group: stats.group },
    created: formatDate(stats.createdMs),
    modified: formatDate(stats.modifiedMs ?? stats.mtimeMs),
  };
  return ejs.render(infoTemplate, data);
}

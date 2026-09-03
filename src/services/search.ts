import ejs from "ejs";
import searchTemplate from "./search.ejs";
import { ConnectionManager } from "../config";
import { RemoteSearchOptions, RemoteSearchResult } from "../types";
import { basename } from "../utils";

export interface SearchOptions extends RemoteSearchOptions {
  connectionId: string;
  maxResults: number;
}

export interface SearchResult {
  connectionId: string;
  name: string;
  path: string;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  isBrokenSymbolicLink?: boolean;
}

export interface SearchTemplateConnection {
  id: string;
  path: string;
}

export interface CreateSearchHtmlOptions {
  connections: SearchTemplateConnection[];
  defaultConnectionId: string;
  defaultSearchDirectory: string;
  defaultValue: string;
  defaultMaxResults: number;
  defaultExcludePatterns: string;
  useDefaultExcludePatterns: boolean;
}

function getSearchNameParts(name: string): { stem: string; extension: string } {
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return { stem: name, extension: "" };
  }

  return {
    stem: name.slice(0, extensionIndex),
    extension: name.slice(extensionIndex),
  };
}

function sortSearchResults(
  results: SearchResult[],
  searchValue: string,
): SearchResult[] {
  const normalizedSearchValue = searchValue
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .toLocaleLowerCase();

  return results.slice().sort((left, right) => {
    const leftFileName = basename(left.path).toLocaleLowerCase();
    const rightFileName = basename(right.path).toLocaleLowerCase();
    const leftExactMatch = leftFileName === normalizedSearchValue ? 0 : 1;
    const rightExactMatch = rightFileName === normalizedSearchValue ? 0 : 1;
    const leftParts = getSearchNameParts(left.name);
    const rightParts = getSearchNameParts(right.name);
    const leftStem = leftParts.stem.toLocaleLowerCase();
    const rightStem = rightParts.stem.toLocaleLowerCase();
    const leftMatchIndex = leftStem.indexOf(normalizedSearchValue);
    const rightMatchIndex = rightStem.indexOf(normalizedSearchValue);
    const leftMatchRank =
      leftStem === normalizedSearchValue ? 0 : leftMatchIndex === 0 ? 1 : 2;
    const rightMatchRank =
      rightStem === normalizedSearchValue ? 0 : rightMatchIndex === 0 ? 1 : 2;

    return (
      leftExactMatch - rightExactMatch ||
      leftMatchRank - rightMatchRank ||
      leftStem.length - rightStem.length ||
      leftStem.localeCompare(rightStem, undefined, { sensitivity: "base" }) ||
      leftParts.extension.localeCompare(rightParts.extension, undefined, {
        sensitivity: "base",
      }) ||
      left.path.localeCompare(right.path, undefined, { sensitivity: "base" })
    );
  });
}

export async function search(
  connectionManager: ConnectionManager,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const definition = connectionManager.getDefinition(options.connectionId);
  if (!definition) {
    throw new Error(`Unknown connection: ${options.connectionId}`);
  }

  const searchValue = options.searchValue.trim();
  if (!searchValue) {
    return [];
  }

  const searchDirectory = options.searchDirectory.trim() || definition.path;
  const connector = connectionManager.getConnectorOrThrow(options.connectionId);
  const configuredLimit = connectionManager.getMaxSearchFiles?.();
  const paths = await connector.searchFiles({
    searchValue,
    searchDirectory,
    limit:
      Number.isInteger(options.maxResults) && options.maxResults >= 1
        ? options.maxResults
        : configuredLimit,
    excludePatterns: options.excludePatterns,
  });

  const results = await Promise.all(
    paths.map(async (result: RemoteSearchResult) => {
      let isDirectory = result.isDirectory;
      let isBrokenSymbolicLink = result.isBrokenSymbolicLink;
      if (result.isSymbolicLink) {
        try {
          isDirectory = (await connector.statPath(result.path)).isDirectory;
        } catch {
          isDirectory = false;
          isBrokenSymbolicLink = true;
        }
      }
      const prefix = result.isSymbolicLink
        ? isBrokenSymbolicLink
          ? "🔗 ⚠️ "
          : "🔗 "
        : "";
      return {
        connectionId: options.connectionId,
        name: `${prefix}${basename(result.path)}`,
        path: result.path,
        isDirectory,
        isSymbolicLink: result.isSymbolicLink,
        isBrokenSymbolicLink,
      };
    }),
  );

  return sortSearchResults(results, searchValue);
}

export function createSearchHtml(options: CreateSearchHtmlOptions): string {
  return ejs.render(searchTemplate, options);
}

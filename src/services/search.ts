import ejs from "ejs";
import searchTemplate from "./search.ejs";
import { ConnectionManager } from "../config";
import { RemoteSearchOptions, RemoteSearchResult } from "../types";
import { basename } from "../utils";

export interface SearchOptions extends RemoteSearchOptions {
  connectionId: string;
}

export interface SearchResult {
  connectionId: string;
  name: string;
  path: string;
  isDirectory: boolean;
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
  const normalizedSearchValue = searchValue.toLocaleLowerCase();

  return results.slice().sort((left, right) => {
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
  const paths = await connector.searchFiles({
    searchValue,
    searchDirectory,
    limit: 200,
    excludePatterns: options.excludePatterns,
  });

  return sortSearchResults(
    paths.map(({ path, isDirectory }: RemoteSearchResult) => ({
      connectionId: options.connectionId,
      name: basename(path),
      path,
      isDirectory,
    })),
    searchValue,
  );
}

export function createSearchHtml(options: CreateSearchHtmlOptions): string {
  return ejs.render(searchTemplate, options);
}

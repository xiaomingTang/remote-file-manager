# Changelog

All notable user-facing changes to Remote File Manager are documented here.

## [0.1.6] - Unreleased

- unify file conflict handling
- fix(sqlite): preview WAL-enabled databases automatically

## [0.1.5]

- add interactive collapsed search options summary
- add a per-search maximum results setting
- add the ability to navigate directly to a remote path with `remoteFileManager.goToPath`
- add search result context menu actions for copying a file or directory name or full path

## [0.1.4]

- update search page layout
- enable anchored name searches with ^ and $

## [0.1.3]

### Changed

- Reorganized the search page layout.
- Made the maximum number of search results configurable through `remoteFileManager.connections.maxSearchFiles`, defaulting to 200.

## [0.1.2]

### Added

- Added side-by-side diff editing for remote files, allowing a remote file to be compared with and edited alongside a local or remote version.
- Reorganize context menu commands
- Add symlink support

## [0.1.1]

### Added

- Added remote file browsing and editing through a dedicated VS Code tree view and virtual filesystem.
- Added connection support for Docker containers, SSH hosts, and local WSL2 distributions.
- Added remote file management operations, including creating, renaming, copying, moving, deleting, uploading, and downloading files and directories.
- Added drag-and-drop and clipboard workflows, including transfers between remote connections.
- Added remote file search with configurable search locations and exclusion patterns.
- Added native remote terminals that open in the selected remote directory.
- Added remote item information panels with metadata such as size, permissions, ownership, and timestamps.
- Added trash-based deletion with restore and permanent purge actions.

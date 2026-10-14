# Upstream watch rows

Each `*.json` file here is one row for [`watch-upstream.yml`](../workflows/watch-upstream.yml). The workflow loads them all with [`scripts/load-upstream-watches.mjs`](../../scripts/load-upstream-watches.mjs), which fails the run when a row is malformed. With no rows, the workflow exits at its first step with a notice.

Rows are separate files so that two pull requests that each add a row never edit the same line.

## Adding a row

Add one file named `<tracker>-<owner>-<repo>-<number>.json`, holding one object:

```json
{
    "tracker": 1,
    "repo": "pestphp/pest-plugin-mutate",
    "kind": "pr",
    "number": 38,
    "composer": "pestphp/pest-plugin-mutate"
}
```

- `tracker` is the issue in this repository that records the work; closing it ends the watch.
- `repo`, `kind` (`issue` or `pr`) and `number` name the upstream thread.
- `composer` is optional: name the package when a local patch in `patches/` depends on it, and the watch also reports a Packagist release past the installed version.
- `released: true` is optional and only valid on a `pr` row: the watch also reports when a release on the pull request's base-branch line contains the merge commit.

A row earns its place only if a terminal signal would make someone act. Each row also needs a note below, saying why it exists and what its signal changes.

## Retiring a row

Delete the row file in the same pull request that removes the patch it served, per the `upstream-patch-lifecycle` skill. Closing the tracking issue also ends the watch.

## Rows

None yet. The template ships the workflow and the loader with no rows; add one when a local patch in `patches/` or another upstream thread earns a watch.

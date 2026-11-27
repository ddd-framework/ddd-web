# @mgamadeus/ddd-web

Read the README for what the package does and how it is built. The rules below apply to every change.

## Contributing: versions and commit messages

- **A pull request never sets a version.** Leave `version` in `composer.json` and in `package.json` as it is, and add
  no version heading to `CHANGELOG.md`. Write the changelog entry under `## Unreleased` at the top of the changelog
  (add the heading when it is missing).
- **The maintainer assigns the version at release:** bumps `composer.json` / `package.json`, renames `## Unreleased` to
  the new version and tags it. Versions are regular only (no pre-release suffixes).
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):** `feat: …`, `fix: …`,
  `docs: …`, `refactor: …`, `test: …`, `chore: …`, optionally with a scope (`fix(chat): …`); a breaking change carries
  `!` after the type or a `BREAKING CHANGE:` footer.
- **Merging a pull request that still carries a version:** keep the version fields of `main`, move its changelog entry
  under `## Unreleased`, then release as usual.
- **Rebase on the current `main` before the merge,** so that only real code conflicts remain.
- **A breaking change is named.** Its changelog entry says what an application must change. The release makes it a
  major version (a package at 1.0 or above) or a minor version (a package still at 0.x).
- **No application terms in a package:** no application's name, and no logic that only one application has (its own
  posts, its own media screens, its own country rules). A package offers hooks; the application individualises
  through them. Review checks this.
- **Tags are never moved or deleted.** A mistake in a release is fixed by a new patch version.

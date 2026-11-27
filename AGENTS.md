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

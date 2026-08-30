## ADDED Requirements

### Requirement: The production dependency tree SHALL contain only imported packages
Every package listed in `dependencies` SHALL be imported by shipped source
(`src/` or `scripts/`); packages used by no code path SHALL be removed rather
than retained or merely patched.

#### Scenario: Unused SDK removed
- **WHEN** the `openai` package is removed from `dependencies`
- **THEN** `npm run lint` and `npm test` SHALL pass unchanged
- **AND** the OpenAI embedding provider SHALL continue to serve embeddings via its
  direct `fetch` calls
- **AND** the production tree SHALL no longer resolve `form-data` through the
  removed package

### Requirement: The dependency tree SHALL be free of known advisories at release
`npm audit` on the full tree SHALL report zero vulnerabilities at the time the
change lands, achieved with in-range updates wherever the advisory permits.

#### Scenario: In-range refresh
- **WHEN** `npm update` / `npm audit fix` is applied without `--force`
- **THEN** `npm audit` SHALL report 0 vulnerabilities
- **AND** the full lint and test suites SHALL pass on the refreshed tree

#### Scenario: Manifest floors track tested versions
- **WHEN** the refresh lands
- **THEN** manifest version floors SHALL be raised so a fresh `npm install` cannot
  resolve a dependency below the version the test suite ran against

### Requirement: The declared Node floor SHALL match the strictest transitive engine requirement on every surface
`engines.node`, the CI Node version, the Docker base images, and the documented
Prerequisites SHALL all state the same floor, and that floor SHALL satisfy every
dependency's `engines` declaration.

#### Scenario: Floor raised to Node 22
- **WHEN** a dependency in the production tree declares `engines.node >=22.0.0`
- **THEN** `package.json` SHALL declare `>=22.0.0`
- **AND** CI SHALL install and test on Node 22
- **AND** both Docker build stages SHALL use a pinned `node:22-slim` digest
- **AND** the Prerequisites table in `README.md` and all four translations SHALL
  state the same floor

#### Scenario: Fresh install on the documented floor
- **WHEN** `npm ci` runs on the documented minimum Node version
- **THEN** no `EBADENGINE` warning SHALL be emitted for any dependency

### Requirement: The lockfile SHALL stay in sync with the manifest
`package-lock.json`'s root `version` SHALL equal the manifest `version`, and
release bumps SHALL use a mechanism that updates both files atomically.

#### Scenario: Version bump
- **WHEN** the package version is bumped for a release
- **THEN** `npm version` SHALL be used
- **AND** the committed lockfile root version SHALL equal the manifest version

### Requirement: Major upgrades SHALL land individually and gated
Pending major upgrades SHALL be applied one at a time, each verified by the full
lint and test suites, and any major blocked by a peer-compatibility constraint
SHALL be recorded as deferred with its blocking condition rather than skipped
silently.

#### Scenario: Dev-tooling major
- **WHEN** vitest is upgraded to its next major
- **THEN** the deprecated transitive `glob@10` SHALL leave the tree
- **AND** the full test suite SHALL pass before any further major is attempted

#### Scenario: Gated runtime major
- **WHEN** a major upgrade (e.g. zod 4) is blocked by an incompatible peer such as
  the MCP SDK
- **THEN** the upgrade SHALL be deferred with the blocking dependency and version
  recorded in the change's tasks

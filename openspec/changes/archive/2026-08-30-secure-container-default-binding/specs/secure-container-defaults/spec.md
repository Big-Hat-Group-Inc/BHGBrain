## ADDED Requirements

### Requirement: Default container start is secure
The default container start SHALL be secure: it MUST either require a bearer token
before the HTTP server is published on a non-loopback interface, or bind to
loopback by default. A default `docker compose up` (no edits, no hand-authored
`.env`) SHALL NOT result in an unauthenticated, externally-reachable memory API,
and SHALL NOT silently crash-loop into one.

#### Scenario: Default start with no token and no overrides
- **WHEN** the container is started with `docker compose up` and no `BHGBRAIN_TOKEN`
  is set
- **AND** no security overrides are provided
- **THEN** the server does NOT expose an unauthenticated API on a non-loopback
  interface
- **AND** it either starts bound to loopback only, or refuses to start with a clear,
  actionable, Docker-aware message naming the env var to set
- **AND** it does NOT crash-loop with a bare, undiagnosable error

#### Scenario: User opts into unauthenticated mode
- **WHEN** a user sets `BHGBRAIN_ALLOW_UNAUTHENTICATED=true` to escape a fail-closed
  start
- **THEN** the published port maps to host loopback (`127.0.0.1:3721:3721`) so the
  unauthenticated API is NOT reachable from the LAN
- **AND** a warning is logged that the server is externally unauthenticated by
  explicit configuration

#### Scenario: External bind with a token provided
- **WHEN** a user sets `BHGBRAIN_TOKEN` and explicitly requests an external bind
- **THEN** the server starts and serves authenticated requests on the external
  interface
- **AND** the fail-closed `validateExternalAuthBinding()` gate is NOT weakened by
  this change

### Requirement: Runtime container runs as a non-root user
The runtime stage of the container image SHALL run the server as a non-root user,
and the `/data` volume SHALL be writable by that user.

#### Scenario: Inspect the running container process
- **WHEN** the container is started and the server process is inspected
- **THEN** the process does NOT run as `root` (uid 0)
- **AND** the non-root user can read `/app` and read/write `/data` (database,
  config, and backups)

### Requirement: Base and sidecar images are pinned
The Dockerfile base image and the `qdrant/qdrant` compose image SHALL be pinned by
digest or a fixed version, and SHALL NOT use `:latest` or other floating tags.

#### Scenario: Inspect image references
- **WHEN** the `Dockerfile` and `docker-compose.yml` image references are inspected
- **THEN** the base image (both builder and runtime stages) is pinned by digest or
  fixed version
- **AND** the `qdrant/qdrant` image is pinned to a fixed version, not `:latest`
- **AND** rebuilding the same source produces the same base/sidecar images

### Requirement: First run succeeds without a hand-created .env
The first `docker compose up` SHALL succeed without the user first creating a
`.env` file: the `env_file` dependency is optional, or the `.env` is scaffolded
and/or its creation is documented as a prerequisite.

#### Scenario: First run with no .env present
- **WHEN** a user runs `docker compose up` and no `.env` file exists
- **THEN** Compose does NOT abort with an "env file not found" error
- **AND** the stack starts (subject to the secure-default-start requirement)

### Requirement: Build context excludes secrets and docs
The `.dockerignore` SHALL exclude `.env`, other secrets, and documentation
(`*.md` / `README*.md`) so they never enter the Docker build context.

#### Scenario: Build the image with secrets and docs present
- **WHEN** a `.env` file and `*.md` docs are present in the repository root
- **AND** the image is built
- **THEN** `.env` and the docs are excluded from the build context
- **AND** no secret is included in the build context or baked into the image

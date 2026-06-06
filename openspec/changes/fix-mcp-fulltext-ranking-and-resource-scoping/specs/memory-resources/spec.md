## ADDED Requirements

### Requirement: Collection and category resource reads SHALL honor namespace scoping

The `collection://` and `category://` resources SHALL resolve the read namespace from an explicit `?namespace=` query parameter, defaulting to `config.defaults.namespace`, and SHALL pass that namespace through to the underlying storage queries. These resources SHALL NOT return data from a namespace other than the resolved one, and SHALL NOT hardcode a fixed namespace (e.g. `global`). If categories are intentionally global (cross-namespace), that behavior SHALL be explicitly documented in the resource contract.

#### Scenario: Default collection read is namespace-scoped

- **WHEN** `collection://list` or `collection://{name}` is read without a `?namespace=` parameter
- **THEN** the namespace resolves to `config.defaults.namespace`
- **AND** only collections and memories in that namespace are returned
- **AND** data from other namespaces is not included

#### Scenario: Explicit namespace selects the target namespace

- **WHEN** `collection://list?namespace=<ns>` or `collection://{name}?namespace=<ns>` is read
- **THEN** the resource returns collections and memories scoped to `<ns>`
- **AND** the namespace is passed through to `listCollections` and the collection-scoped query rather than being ignored

#### Scenario: Cross-namespace data is not exposed by default

- **WHEN** memories or collections exist in a namespace other than the resolved read namespace
- **AND** a `collection://` resource is read without explicitly requesting that other namespace
- **THEN** those cross-namespace memories and collections are not returned

#### Scenario: Category read namespace behavior is explicit

- **WHEN** `category://list` or `category://{name}` is read
- **THEN** the resource either scopes categories to the resolved namespace
- **AND** or treats categories as global cross-namespace and documents that intent in the resource contract
- **AND** the behavior is deterministic and not dependent on an undocumented hardcoded namespace

## ADDED Requirements

### Requirement: Documentation SHALL NOT present the HTTP transport as an MCP transport
User-facing documentation SHALL describe the HTTP transport as a REST interface over tools and
resources. It SHALL NOT describe the HTTP transport as an MCP transport, and SHALL NOT present MCP
client configurations that point an MCP client at the HTTP port, for as long as the HTTP transport
does not implement an MCP wire protocol.

#### Scenario: No MCP client configuration targets the REST port
- **WHEN** a reader searches the documentation for MCP client configuration examples
- **THEN** no example configures an MCP client with the HTTP transport URL
- **AND** no example presents a transport value the server does not implement

#### Scenario: The limitation is stated, not merely omitted
- **WHEN** a reader consults the HTTP transport documentation
- **THEN** the documentation states that this interface is not an MCP endpoint
- **AND** states that it cannot be registered as an MCP server

### Requirement: Documented client configurations SHALL be ones that connect
Every MCP client configuration shown in user-facing documentation SHALL use a transport the server
actually implements, such that a reader who copies it can connect to a correctly installed server.

#### Scenario: The documented client example connects
- **WHEN** a reader copies a documented MCP client configuration for a correctly installed server
- **THEN** the client establishes an MCP session
- **AND** the server tools are listed by the client

#### Scenario: Named clients have a working recipe
- **WHEN** the documentation names a specific MCP client as supported
- **THEN** the documentation provides a configuration for that client using a transport the server
  implements

### Requirement: Documented HTTP routes SHALL match the implemented routes
Documentation of the HTTP interface SHALL list the routes the server actually registers, and SHALL
indicate any route that is conditional on configuration.

#### Scenario: Route list matches the implementation
- **WHEN** the documented HTTP routes are compared against the routes registered by the HTTP
  transport
- **THEN** the documented set matches the implemented set
- **AND** no documented route is absent from the implementation

#### Scenario: Conditional routes are marked as conditional
- **WHEN** a route is registered only when a configuration flag is enabled
- **THEN** the documentation identifies the flag that enables it

### Requirement: Transport claims SHALL be consistent across diagrams, prose, and translations
Statements about which transports carry MCP SHALL be consistent wherever they appear, including
architecture diagrams, narrative prose, and translated documentation.

#### Scenario: Diagrams agree with prose
- **WHEN** an architecture diagram labels the transport between an MCP client and the server
- **THEN** the label names only transports over which MCP is actually served

#### Scenario: Translations agree with the source document
- **WHEN** a translated document describes transports or client configuration
- **THEN** it makes the same transport claims as the source document
- **AND** it does not retain a client configuration that the source document has corrected

## ADDED Requirements

### Requirement: Cache file written with restrictive permissions
The cache file SHALL be written with mode `0600` on POSIX systems.

#### Scenario: Cache written rw for owner only
- **WHEN** the extension writes the cache file on a POSIX system
- **THEN** the file mode is `0600` (owner read/write, no group/other access)

### Requirement: Cache validated on read
The extension SHALL schema-validate the cache file on read and SHALL degrade gracefully to
"no data" when validation fails.

#### Scenario: Invalid cache yields no data
- **WHEN** the cache file has a wrong version, malformed JSON, or out-of-range fields
- **THEN** the read returns null and the extension shows "no data" without crashing

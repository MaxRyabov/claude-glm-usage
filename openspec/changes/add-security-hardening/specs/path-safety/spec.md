## ADDED Requirements

### Requirement: JSONL discovery confined to ~/.claude/projects
JSONL file discovery SHALL reject any path that resolves outside `~/.claude/projects/`.

#### Scenario: Traversal path is rejected
- **WHEN** a discovered path (e.g. via a symlink) resolves outside `~/.claude/projects/`
- **THEN** that path is filtered out and not read

## ADDED Requirements

### Requirement: Cost is priced per model
The extension SHALL compute the cost of each JSONL usage entry using a `TokenPricing` resolved
from that entry's `message.model`, rather than a single global tier.

#### Scenario: GLM and Claude entries in the same window
- **WHEN** a usage window contains both a `glm-4.6` entry and a `claude-opus-*` entry
- **THEN** each entry is priced with its own model rates and the window cost is their sum

#### Scenario: Unknown model falls back
- **WHEN** an entry's model matches no built-in or user-defined rate
- **THEN** the entry is priced with the configured flat `claudeStatus.pricing.*` default

### Requirement: Built-in model price table
The extension SHALL ship a built-in price table covering current z.ai GLM tiers and Claude
tiers, matched by longest case-insensitive prefix of the model name.

#### Scenario: Longest prefix wins
- **WHEN** the model is `glm-4.5-air`
- **THEN** the `glm-4.5-air` rate is used, not the shorter `glm-4.5` rate

#### Scenario: Free and synthetic models cost nothing
- **WHEN** the model is `<synthetic>`, empty, or a free flash model (e.g. `glm-4.7-flash`)
- **THEN** the resolved cost is zero

### Requirement: User price overrides
The `claudeStatus.pricing.models` setting SHALL let users override per-model rates, taking
precedence over the built-in table.

#### Scenario: Override beats built-in
- **WHEN** `pricing.models` defines a rate for `glm-4.6`
- **THEN** that rate is used instead of the built-in `glm-4.6` rate

### Requirement: Provider default pricing
When a model is unknown but the provider is `z-ai`, the extension SHALL price the entry using a
GLM default tier rather than the Claude flat default.

#### Scenario: z-ai unknown model
- **WHEN** the provider is `z-ai` and the model matches no table entry or override
- **THEN** the entry is priced with the z.ai (GLM-4.7) default tier

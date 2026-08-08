---
name: azure-async-infra
description: Project adapter for azure-async-infra. Customize for your project.
---

# azure-async-infra — Project Adapter


Inspect this project's infrastructure definitions before proposing any change:
- The shared async baseline (Blob containers and Service Bus queues/topics) —
  usually a Terraform file under this repo's infrastructure directory
- The infrastructure README covering environment and module naming conventions

## Project-specific scale-up triggers (require ADR before deviating from defaults)

- > 50 concurrent jobs sustained for > 1 week → evaluate dedicated queue
- Fan-out to > 3 downstream consumers → evaluate topic + subscriptions
- Blast-radius or compliance isolation required → evaluate separate namespace/account

## Terraform conventions

See `{{slot:skillsDir}}terraform-infra/SKILL.md` for Terraform file layout,
naming, and tagging rules.

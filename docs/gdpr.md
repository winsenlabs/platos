---
title: "GDPR and data lifecycle"
description: "Operator responsibilities for access, portability, retention, and hard erasure in self-hosted Platos."
sidebarTitle: "GDPR"
---

# GDPR and data lifecycle

Platos is self-hosted software. The operator determines its legal role, lawful basis, retention policy, subprocessors, and response process. This page is an operational map, not legal advice.

The authoritative destructive API and evidence model are documented in [GDPR hard erasure](./gdpr-erasure.md). The public reference version is [Hard erasure](../content/docs/hard-erasure.md).

## Data locations

Subject-linked data may exist in four store classes:

1. **Postgres**: `EndUser`, `Thread`, `Turn`, `Step`, `ToolCall`, Memory records, Artifacts, attachment metadata, approvals, safety events, ratings, and scoped audit metadata.
2. **ClickHouse**: analytical projections for traces, cost, latency, and policy signals when configured.
3. **Object storage**: attachment and Artifact bytes.
4. **Redis**: ephemeral sessions, rate-limit state, caches, and in-flight coordination.

Organization, Project, and Environment ancestry defines the tenant boundary. An erasure request is Organization-scoped and resolves all linked identities for the requested subject inside that Organization.

## Access and portability

Build exports from scoped, persisted records. Include the subject's Threads, Turns, Memories, Artifacts, attachments, ratings, and other subject-owned records in a structured, machine-readable format. Redact other people's data and operator-only security metadata.

An export is not proof of deletion. Use the inventory and hard-erasure receipt for that purpose.

## Retention

Set retention by data class and document it in the operator's privacy notice. Shorter retention is usually appropriate for raw prompts, attachment bytes, traces, and transient caches than for aggregate financial records.

A scheduled cleanup Job may enforce ordinary retention. A verified hard-erasure request must not rely on eventual retention alone.

## Hard erasure summary

1. Resolve the subject from `externalUserId` and every linked identity inside one Organization.
2. Check legal holds before creating or mutating an erasure operation.
3. Quiesce subject writes when late events could recreate data.
4. Sweep object, ephemeral, analytical, and transactional stores in the documented order.
5. Probe each configured store for survivors.
6. Keep a metadata-only receipt and retry unsettled stores.
7. Verify independently with the subject inventory endpoint.

Only `deleted` and `nothing_to_delete` are positive deletion evidence. `not_provisioned` means the store is not wired into this installation; it is not evidence about an external store the operator uses.

## Operator checklist

- Maintain a store inventory and owner for every data class.
- Test exports and hard erasure in a non-production Environment.
- Configure legal holds and record who may change them.
- Verify ClickHouse and object-storage connectivity before relying on receipts.
- Keep secrets and raw credential material out of exports, logs, traces, and receipts.
- Re-check restored backups before returning an installation to service.

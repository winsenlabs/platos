---
slug: batches
title: Batch requests
description: Submit repeated independent inputs without introducing another execution resource.
category: platform
order: 10
questions:
  - "How do I process many inputs with one Agent Version?"
  - "How are batch items observed?"
related:
  - turns
  - jobs
  - observability
---

# Batch requests

A batch is a client convenience for submitting many independent inputs. It is not a durable top-level Platos noun.

Each accepted item creates its own Turn in the selected Thread or its own Job when the work is asynchronous. Status, cost, retries, and errors remain attached to those canonical records.

Use a stable idempotency key per item. A client can retry submission without duplicating accepted work, and partial failures do not hide successful items.

For large asynchronous sets, create a coordinating Job whose input contains item identifiers. Keep item payloads in normal scoped storage rather than embedding sensitive values in Job metadata.

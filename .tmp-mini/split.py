import sys

src = 'packages/adapters/postgres-tenancy/src/providers-constraints.integration.test.ts'
lines = open(src).read().split('\n')

# 1-indexed describe starts from the grep above.
CATALOGUE_START = 301  # "ModelPrice_rate_check"
INSTANTS_START = 543   # "the instant and page-window guards"

head = lines[:CATALOGUE_START - 1]                      # through ProviderKey_owner_immutable
catalogue = lines[CATALOGUE_START - 1:INSTANTS_START - 1]
tail = lines[INSTANTS_START - 1:]                       # the instant/page-window block

open('/tmp/pl-head.txt', 'w').write('\n'.join(head))
open('/tmp/pl-catalogue.txt', 'w').write('\n'.join(catalogue))
open('/tmp/pl-tail.txt', 'w').write('\n'.join(tail))
print('head', len(head), 'catalogue', len(catalogue), 'tail', len(tail))

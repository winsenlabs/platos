import re

s = open('internal-packages/tenancy-database/prisma/schema.prisma').read()
maps = {'Agent': 8, 'AgentBinding': 9, 'AgentCluster': 8, 'AgentVersion': 17, 'AgentSkill': 7,
        'Macro': 10, 'PostmanTemplate': 10, 'Tool': 9, 'ToolCall': 14, 'ToolCallAudit': 15,
        'Event': 6, 'EntityMcpConfig': 11}
want = set(maps)
scalar = ('String', 'Int', 'Boolean', 'DateTime', 'Json', 'Float', 'Decimal', 'BigInt', 'Bytes')
model = None
cols = {}
for line in s.split('\n'):
    t = line.strip()
    m = re.match(r'^model\s+(\w+)\s*\{', t)
    if m:
        model = m.group(1)
        cols.setdefault(model, [])
        continue
    if t == '}':
        model = None
        continue
    if model in want and re.match(r'^\w+\s+\S', t) and not t.startswith('@@'):
        parts = t.split()
        cols[model].append((parts[0], parts[1]))

for m in sorted(want):
    keep = [c for c in cols.get(m, []) if c[1].rstrip('?[]') in scalar]
    print('%-18s scalar=%3d map=%3d delta=%+d' % (m, len(keep), maps[m], len(keep) - maps[m]))
    if len(keep) != maps[m]:
        print('       ', [c[0] for c in keep])

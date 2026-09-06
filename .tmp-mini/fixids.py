import sys

edits = {
 'packages/adapters/postgres-tenancy/src/providers-conformance.ts': [
   ('credentialId: asProvidersIdentifier(credentialId),','credentialId: asProvidersIdentifier<CredentialId>(credentialId),'),
   ('credentialName: asProvidersIdentifier(credentialName),','credentialName: asProvidersIdentifier<CredentialName>(credentialName),'),
   ('createdBy: asProvidersIdentifier("operator-1"),','createdBy: asProvidersIdentifier<ActorId>("operator-1"),'),
   ('environmentProviderId: asProvidersIdentifier(id),','environmentProviderId: asProvidersIdentifier<EnvironmentProviderId>(id),'),
   ('import type {\n  EnvironmentScope,\n  ProviderId,','import type {\n  ActorId,\n  CredentialId,\n  CredentialName,\n  EnvironmentProviderId,\n  EnvironmentScope,\n  ProviderId,'),
 ],
 'packages/adapters/postgres-tenancy/src/providers-conformance-catalogue.ts': [
   ('provider: asProvidersIdentifier(provider),','provider: asProvidersIdentifier<ProviderId>(provider),'),
   ('import type {\n  ModelFacts,','import type {\n  ModelFacts,\n  ProviderId,'),
 ],
 'packages/adapters/postgres-tenancy/src/providers-constraints.integration.test.ts': [
   ('credentialId: asProvidersIdentifier(credentialId),','credentialId: asProvidersIdentifier<CredentialId>(credentialId),'),
   ('credentialName: asProvidersIdentifier("ANTHROPIC_PRIMARY"),','credentialName: asProvidersIdentifier<CredentialName>("ANTHROPIC_PRIMARY"),'),
   ('createdBy: asProvidersIdentifier("operator-1"),','createdBy: asProvidersIdentifier<ActorId>("operator-1"),'),
   ('credentialId: asProvidersIdentifier(other),','credentialId: asProvidersIdentifier<CredentialId>(other),'),
   ('credentialName: asProvidersIdentifier("ANTHROPIC_SOMETHING_ELSE"),','credentialName: asProvidersIdentifier<CredentialName>("ANTHROPIC_SOMETHING_ELSE"),'),
   ('credentialName: asProvidersIdentifier("NOT_THE_CREDENTIAL_NAME"),','credentialName: asProvidersIdentifier<CredentialName>("NOT_THE_CREDENTIAL_NAME"),'),
   ('          asProvidersIdentifier(modelId),','          asProvidersIdentifier<ModelId>(modelId),'),
   ('        asProvidersIdentifier(modelId),','        asProvidersIdentifier<ModelId>(modelId),'),
   ('        asProvidersIdentifier(uuid("00ff")),','        asProvidersIdentifier<ModelId>(uuid("00ff")),'),
   ('import type {\n  EnvironmentScope,\n  ModelKey,','import type {\n  ActorId,\n  CredentialId,\n  CredentialName,\n  EnvironmentScope,\n  ModelId,\n  ModelKey,'),
 ],
}

for path, pairs in edits.items():
    s = open(path).read()
    for a, b in pairs:
        if a not in s:
            sys.exit("MISS %s: %s" % (path, a[:60]))
        s = s.replace(a, b)
    open(path, 'w').write(s)
print("ok")

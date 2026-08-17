CREATE SCHEMA cutover_legacy;

CREATE TABLE cutover_legacy.cutover_id_map (
  mapping_version integer NOT NULL,
  source_model text NOT NULL,
  source_id text NOT NULL,
  target_model text NOT NULL,
  target_id text NOT NULL,
  stable_suffix text NOT NULL
);

CREATE TABLE cutover_legacy."PlatosAgentMessage" (
  id text PRIMARY KEY,
  role text NOT NULL,
  content text,
  "thinkingContent" text,
  "encKeyVersion" integer
);
CREATE TABLE cutover_legacy."PlatosToolCallAudit" (
  id text PRIMARY KEY,
  args jsonb NOT NULL,
  result jsonb
);
CREATE TABLE cutover_legacy."PlatosSafetyEvent" (
  id text PRIMARY KEY,
  detail text,
  meta jsonb
);
CREATE TABLE cutover_legacy."PlatosMemory" (
  id text PRIMARY KEY,
  content text NOT NULL,
  metadata jsonb
);
CREATE TABLE cutover_legacy."PlatosMemoryEntity" (
  id text PRIMARY KEY,
  label text NOT NULL,
  metadata jsonb
);
CREATE TABLE cutover_legacy."PlatosMemoryRelationship" (
  id text PRIMARY KEY,
  metadata jsonb
);

CREATE TABLE public."Turn" (
  id text PRIMARY KEY,
  "outputText" text,
  "thinkingContent" text
);
CREATE TABLE public."ToolCallAudit" (
  id text PRIMARY KEY,
  arguments jsonb NOT NULL,
  result jsonb
);
CREATE TABLE public."SafetyEvent" (
  id text PRIMARY KEY,
  detail text,
  metadata jsonb
);
CREATE TABLE public."Memory" (
  id text PRIMARY KEY,
  content text NOT NULL,
  metadata jsonb
);
CREATE TABLE public."MemoryEntity" (
  id text PRIMARY KEY,
  label text NOT NULL,
  metadata jsonb
);
CREATE TABLE public."MemoryRelationship" (
  id text PRIMARY KEY,
  metadata jsonb
);

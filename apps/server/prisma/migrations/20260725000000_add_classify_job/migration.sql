-- L4 Phase-3 classify job type (design 2026-07-20 §10, §13). Additive only.
-- Rollback: none needed — PG enum values are not removable; the value is inert while unused.
ALTER TYPE "PushJobType" ADD VALUE 'classify';

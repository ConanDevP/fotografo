-- PostgreSQL requires a newly-added enum value to be committed before it is
-- referenced by later data migrations.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ORGANIZER';


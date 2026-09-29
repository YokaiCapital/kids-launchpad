-- Existing grants retain legacy semantics. New program grants name their version explicitly.
ALTER TABLE signer_capabilities ADD COLUMN program_version INTEGER NOT NULL DEFAULT 1 CHECK(program_version IN (1,2));

-- One signed message has one network signature/cost for this payer and chain.
-- Refuse migration if an older accounting fixture contains duplicate financial
-- identities: never silently delete or merge prior spend/hold evidence.
CREATE UNIQUE INDEX operating_spend_message_identity ON operating_spend_holds(genesis_hash,payer,message_hash);

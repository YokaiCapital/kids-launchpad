// Asynchronous production registry operations. SQLite remains the legacy synchronous adapter.
// All SQL and validation/row codecs are shared; operations are parity-tested against both engines.
import {randomUUID} from 'node:crypto';
import {canonicalJson} from './canonical.mjs';
import {NEVER_GRANTABLE_TAGS,DEFAULT_LIMITS} from '../signer-policy.mjs';
import {assertMintTransition,campaignOrdering,SQL,MODES,REGISTRY_STATUSES,CHAIN_STATUSES,MINT_LEASE_STATES,CAPABILITY_KINDS,EVENT_STATUSES,DEFAULT_PAGE,MAX_PAGE,campaignId,campaignIdentity,parseCampaignId,isAddress,decodeCursor,encodeCursor,normalizeCampaign,mergeCampaign,isoNow,ADDRESS,SIGNATURE,DECIMAL,PATH,KEY,SLUG,HEX64,parseJson,rowToCampaign,rowToIntent,rowToJob,rowToCapability,rowToBudget,rowToLease,rowToEvent,optAddress,optDecimal,optInt,optText,optIso,campaignValues} from './registry.mjs';
/** Builds the adapter API over a driver exposing get/all/run(sql,params) and transaction(fn); the SQL is identical for every engine. */
export function asyncRegistryApi(driver, {
  now = Date.now
} = {}) {
  const {
    get,
    all,
    run,
    transaction
  } = driver;
  const campaigns = {
    /** Inserts or merges; returns {inserted, updated, conflicts, campaign}. A rerun with the same data changes nothing. */
    async upsert(input) {
      const next = normalizeCampaign(input);
      return await transaction(async () => {
        const existing = rowToCampaign(await get(SQL.campaignGet, [next.genesisHash, next.programId, next.campaign]));
        const at = isoNow(now);
        if (!existing) {
          const ordinal = Number((await get(SQL.campaignNextOrdinal, [])).next);
          await run(SQL.campaignInsert, campaignValues(next, ordinal, at, at));
          return {
            inserted: true,
            updated: false,
            conflicts: [],
            campaign: rowToCampaign(await get(SQL.campaignGet, [next.genesisHash, next.programId, next.campaign]))
          };
        }
        const {
          merged,
          conflicts
        } = mergeCampaign(existing, next);
        const before = campaignValues(existing, existing.ordinal, existing.createdAt, ''),
          after = campaignValues(merged, existing.ordinal, existing.createdAt, '');
        if (before.join('\u0000') === after.join('\u0000')) return {
          inserted: false,
          updated: false,
          conflicts,
          campaign: existing
        };
        const values = campaignValues(merged, existing.ordinal, existing.createdAt, at);
        await run(SQL.campaignUpdate, [...values.slice(4, 33), at, merged.genesisHash, merged.programId, merged.campaign]);
        return {
          inserted: false,
          updated: true,
          conflicts,
          campaign: rowToCampaign(await get(SQL.campaignGet, [next.genesisHash, next.programId, next.campaign]))
        };
      }, {lockKey:'campaign:'+next.genesisHash+':'+next.programId+':'+next.campaign});
    },
    /** Full identity, or a bare campaign address (unique across genesis and program, else an error asking for the full id). */
    async get(ref) {
      const id = typeof ref === 'string' ? parseCampaignId(ref) : ref;
      if (!id) return null;
      if (id.genesisHash) return rowToCampaign(await get(SQL.campaignGet, [id.genesisHash, id.programId, id.campaign]));
      const rows = await all(SQL.campaignByAddress, [id.campaign]);
      if (rows.length > 1) {
        const e = Error('Campaign address is ambiguous across ledgers; use genesis:program:campaign');
        e.code = 'AMBIGUOUS';
        throw e;
      }
      return rowToCampaign(rows[0]);
    },
    async bySlug(slug) {
      if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
      return rowToCampaign(await get(SQL.campaignBySlug, [slug]));
    },
    /** Newest first by ordinal; filters: status (a chain status or 'unknown'), mode, registryStatus; cursor from the previous page. */
    async list({
      status = null,
      mode = null,
      registryStatus = null,
      creator = null,
      query = null,
      sort = 'newest',
      cursor = null,
      limit = DEFAULT_PAGE
    } = {}) {
      if (status != null && status !== 'unknown' && !CHAIN_STATUSES.includes(status)) throw Error('Unknown status filter');
      if (mode != null && !MODES.includes(mode)) throw Error('Unknown mode filter');
      if (registryStatus != null && !REGISTRY_STATUSES.includes(registryStatus)) throw Error('Unknown registryStatus filter');
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw Error('limit must be 1..' + MAX_PAGE);
      if (creator != null && !isAddress(creator)) throw Error('Invalid creator filter');
      if (query != null && (typeof query !== 'string' || query.length > 100)) throw Error('Invalid search');
      const search = query ? '%' + query.toLowerCase().replace(/[!%_]/g, '!$&') + '%' : null;
      const ordering = campaignOrdering(sort,cursor),
        chain = status === 'unknown' ? null : status,
        unknown = status === 'unknown' ? 1 : null;
      const rows = (await all(SQL.campaignList.split(' AND (CAST(? AS BIGINT)')[0]+ordering.tail, [chain, chain, unknown, mode, mode, registryStatus, registryStatus, creator, creator, search, search, search, query, ...ordering.params, limit + 1])).map(rowToCampaign);
      const page = rows.slice(0, limit);
      return {
        campaigns: page,
        nextCursor: rows.length > limit ? ordering.cursor(page[page.length - 1]) : null
      };
    },
    async count() {
      return Number((await get(SQL.campaignCount, [])).n);
    }
  };
  const intents = {
    /** Idempotent on (campaign, wallet, action, idempotencyKey): the same key returns the same intent; the same key with
     * different financial parameters is refused. Returns {intent, created}. */
    async create({
      genesisHash,
      programId,
      campaign,
      wallet,
      action,
      idempotencyKey,
      params,
      messageDigest = null,
      status = 'prepared'
    }) {
      const id = campaignIdentity({
        genesisHash,
        programId,
        campaign
      });
      if (!isAddress(wallet)) throw Error('Invalid wallet');
      if (typeof action !== 'string' || !KEY.test(action)) throw Error('Invalid action');
      if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey)) throw Error('Invalid idempotency key');
      if (messageDigest != null && !HEX64.test(messageDigest)) throw Error('messageDigest must be a sha256 hex');
      const paramsJson = canonicalJson(params ?? {});
      return await transaction(async () => {
        const at = isoNow(now);
        const inserted = Number((await run(SQL.intentInsert, [randomUUID(), id.genesisHash, id.programId, id.campaign, wallet, action, idempotencyKey, messageDigest, paramsJson, status, null, at, at])).changes) === 1;
        const intent = rowToIntent(await get(SQL.intentByKey, [id.genesisHash, id.programId, id.campaign, wallet, action, idempotencyKey]));
        if (!inserted && canonicalJson(intent.params) !== paramsJson) {
          const e = Error('Idempotency key reused with different parameters');
          e.code = 'IDEMPOTENCY_CONFLICT';
          throw e;
        }
        if (!inserted && messageDigest && intent.messageDigest && intent.messageDigest !== messageDigest) {
          const e = Error('Idempotency key reused with a different approved message');
          e.code = 'IDEMPOTENCY_CONFLICT';
          throw e;
        }
        return {
          intent,
          created: inserted
        };
      });
    },
    async get(intentId) {
      return rowToIntent(await get(SQL.intentGet, [intentId]));
    },
    /** Moves an intent forward (prepared, signed, submitted, confirmed, failed); the digest is set once, the signature kept once known. */
    async progress({
      intentId,
      status,
      signature = null,
      messageDigest = null
    }) {
      if (typeof status !== 'string' || !KEY.test(status)) throw Error('Invalid status');
      if (signature != null && !SIGNATURE.test(signature)) throw Error('Invalid signature');
      return Number((await run(SQL.intentProgress, [status, signature, messageDigest, isoNow(now), intentId])).changes) === 1;
    }
  };
  const jobs = {
    /** One job per (campaign, operationKey); a repeat enqueue returns the existing job. */
    async enqueue({
      genesisHash,
      programId,
      campaign,
      operationKey,
      jobClass,
      payload = {},
      deadlineAt = null,
      notBefore = null
    }) {
      const id = campaignIdentity({
        genesisHash,
        programId,
        campaign
      });
      if (typeof operationKey !== 'string' || !KEY.test(operationKey)) throw Error('Invalid operation key');
      if (typeof jobClass !== 'string' || !KEY.test(jobClass)) throw Error('Invalid job class');
      optIso(deadlineAt, 'deadlineAt');
      optIso(notBefore, 'notBefore');
      return await transaction(async () => {
        const at = isoNow(now);
        const created = Number((await run(SQL.jobInsert, [randomUUID(), id.genesisHash, id.programId, id.campaign, operationKey, jobClass, 'queued', canonicalJson(payload), at, at, notBefore, deadlineAt])).changes) === 1;
        return {
          job: rowToJob(await get(SQL.jobByKey, [id.genesisHash, id.programId, id.campaign, operationKey])),
          created
        };
      });
    },
    /** Leases the oldest queued job (or one whose lease expired); the fencing token grows by one on every lease. Returns null when nothing is due. */
    async lease({
      owner,
      ttlMs = 30000,
      jobClass = null
    }) {
      if (typeof owner !== 'string' || !KEY.test(owner)) throw Error('Invalid lease owner');
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw Error('ttlMs must be 1 s..1 h');
      return await transaction(async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const t = now(),
            at = new Date(t).toISOString(),
            expires = new Date(t + ttlMs).toISOString();
          const row = await get(SQL.jobNext, [at, at, jobClass, jobClass]);
          if (!row) return null;
          const retry = row.state === 'leased' ? 1 : 0;
          if (Number((await run(SQL.jobLease, [owner, expires, retry, at, row.job_id, row.fencing_token, at])).changes) === 1) return rowToJob(await get(SQL.jobGet, [row.job_id]));
        }
        return null;
      });
    },
    async renew({
      jobId,
      token,
      owner,
      ttlMs = 30000
    }) {
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw Error('Invalid lease duration');
      const t = now();
      return Number((await run(SQL.jobRenew, [new Date(t + ttlMs).toISOString(), new Date(t).toISOString(), jobId, token, owner, new Date(t).toISOString()])).changes) === 1;
    },
    /** Publishes a result only with the current fencing token; a stale holder gets an error and changes nothing. */
    async complete({
      jobId,
      token,
      result = {}
    }) {
      if (Number((await run(SQL.jobComplete, [canonicalJson(result), isoNow(now), jobId, token, isoNow(now)])).changes) !== 1) {
        const e = Error('Stale or unknown lease for job ' + jobId);
        e.code = 'STALE_LEASE';
        throw e;
      }
      return rowToJob(await get(SQL.jobGet, [jobId]));
    },
    /** Fails with the current token: requeue=true puts it back in the queue (retry counted at the next lease), else state 'failed'. */
    async fail({
      jobId,
      token,
      error,
      requeue = false,
      result = {}
    }) {
      if (Number((await run(SQL.jobFail, [requeue ? 'queued' : 'failed', canonicalJson({
        ...result,
        error: String(error ?? '').slice(0, 400)
      }), isoNow(now), jobId, token, isoNow(now)])).changes) !== 1) {
        const e = Error('Stale or unknown lease for job ' + jobId);
        e.code = 'STALE_LEASE';
        throw e;
      }
      return rowToJob(await get(SQL.jobGet, [jobId]));
    },
    async get(jobId) {
      return rowToJob(await get(SQL.jobGet, [jobId]));
    },
    /** Every job that could be leased now (queued, or leased with an expired lease, and past its not-before time), oldest first. */
    async due({
      limit = 100
    } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('limit must be 1..1000');
      const at = isoNow(now);
      return (await all(SQL.jobDue, [at, at, limit])).map(rowToJob);
    },
    /** Leases one specific job by id with the token the caller saw; null when another process got there first. */
    async leaseById({
      jobId,
      token,
      owner,
      ttlMs = 30000
    }) {
      if (typeof owner !== 'string' || !KEY.test(owner)) throw Error('Invalid lease owner');
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw Error('ttlMs must be 1 s..1 h');
      return await transaction(async () => {
        const row = await get(SQL.jobGet, [jobId]);
        if (!row || Number(row.fencing_token) !== token) return null;
        const t = now(),
          at = new Date(t).toISOString(),
          expires = new Date(t + ttlMs).toISOString();
        const retry = row.state === 'leased' ? 1 : 0;
        if (Number((await run(SQL.jobLease, [owner, expires, retry, at, jobId, token, at])).changes) !== 1) return null;
        return rowToJob(await get(SQL.jobGet, [jobId]));
      });
    },
    /** True while this owner holds the current lease (token and owner match, not expired). Side effects check it first. */
    async holds({
      jobId,
      token,
      owner
    }) {
      return !!(await get(SQL.jobHolds, [jobId, token, owner, isoNow(now)]));
    },
    /** Puts a leased job back in the queue with the current token, a result (outcome, attempts, reconcile facts) and a not-before time. */
    async requeue({
      jobId,
      token,
      result = {},
      notBefore = null
    }) {
      optIso(notBefore, 'notBefore');
      if (Number((await run(SQL.jobRequeue, [canonicalJson(result), notBefore, isoNow(now), jobId, token, isoNow(now)])).changes) !== 1) {
        const e = Error('Stale or unknown lease for job ' + jobId);
        e.code = 'STALE_LEASE';
        throw e;
      }
      return rowToJob(await get(SQL.jobGet, [jobId]));
    },
    async listForCampaign({
      genesisHash,
      programId,
      campaign,
      limit = DEFAULT_PAGE
    }) {
      const id = campaignIdentity({
        genesisHash,
        programId,
        campaign
      });
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('limit must be 1..1000');
      return (await all(SQL.jobListCampaign, [id.genesisHash, id.programId, id.campaign, limit])).map(rowToJob);
    }
  };
  const capabilities = {
    /** Grants a signer capability to one campaign. tags: launch-program instruction tags; recipients: addresses whose token
     * accounts the keeper may sponsor (empty for the keeper kind); limits: overrides of the signer's DEFAULT_LIMITS. */
    async grant({
      genesisHash,
      programId,
      campaign,
      kind = 'keeper',
      programVersion = 1,
      tags,
      recipients = [],
      limits = {},
      expiresAt
    }) {
      const id = campaignIdentity({
        genesisHash,
        programId,
        campaign
      });
      if (!CAPABILITY_KINDS.includes(kind)) throw Error('kind must be one of ' + CAPABILITY_KINDS.join(', '));
      if(![1,2,3].includes(programVersion))throw Error('Unknown capability program version');
      if (!Array.isArray(tags) || (!tags.length && kind !== 'operating-return') || tags.some(t => !Number.isInteger(t) || t < 0 || t > 255)) throw Error('tags must be a list of instruction tags 0..255');
      for (const t of tags) if (NEVER_GRANTABLE_TAGS.has(t)) throw Error('Tag ' + t + ' can never be granted: it sets recipients, authorities or parents, or is user-signed');
      if (!Array.isArray(recipients) || recipients.some(r => !isAddress(r))) throw Error('recipients must be addresses');
      if (kind === 'keeper' && recipients.length) throw Error('a keeper capability carries no recipients');
      if(kind==='fee-setup'&&(programVersion!==3||tags.length!==1||tags[0]!==20||recipients.length<1||recipients.length>2||new Set(recipients).size!==recipients.length))throw Error('Fee setup requires v3, tag 20 and sealed recipients');
      if(kind==='operating-return'&&(programVersion!==3||tags.length!==0||recipients.length!==1))throw Error('Operating return requires v3, no tags and exactly one recipient (the sealed creator)');
      if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.values(limits).some(v => !Number.isSafeInteger(v) || v < 0)) throw Error('limits must be non-negative integers');
      // A grant whose limit keys the signer does not know would be skipped by the signer as unserved: refuse it here instead.
      for (const k of Object.keys(limits)) if (!Object.hasOwn(DEFAULT_LIMITS, k)) throw Error('Unknown limit ' + k + '; the signer honours ' + Object.keys(DEFAULT_LIMITS).join(', '));
      if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) throw Error('expiresAt must be an ISO time');
      return await transaction(async () => {
        // A per-campaign lock and monotonic timestamp make "latest" deterministic
        // even when concurrent grants share a millisecond or a host clock moves back.
        const prior=await get(SQL.capabilityLatest,[id.genesisHash,id.programId,id.campaign]);
        const at=new Date(Math.max(now(),prior?Date.parse(prior.created_at)+1:0)).toISOString(),capabilityId=randomUUID();
        await run(SQL.capabilityInsert, [capabilityId, id.genesisHash, id.programId, id.campaign, kind, JSON.stringify([...new Set(tags)].sort((a, b) => a - b)), JSON.stringify(recipients), canonicalJson(limits), new Date(Date.parse(expiresAt)).toISOString(), at, programVersion]);
        return rowToCapability(await get('SELECT * FROM signer_capabilities WHERE capability_id=?', [capabilityId]));
      },{lockKey:'capability:'+campaignId(id)});
    },
    /** Live grants (not revoked, not expired) unless includeExpired. */
    async list({
      includeExpired = false
    } = {}) {
      return (includeExpired ? await all(SQL.capabilityAll, []) : await all(SQL.capabilityList, [isoNow(now)])).map(rowToCapability);
    },
    async latest(identity) {
      const id=campaignIdentity(identity);
      return rowToCapability(await get(SQL.capabilityForCampaign,[id.genesisHash,id.programId,id.campaign]));
    },
    async revoke(capabilityId) {
      return Number((await run(SQL.capabilityRevoke, [isoNow(now), capabilityId])).changes) === 1;
    }
  };
  const budgets = {
    async get({
      genesisHash,
      programId,
      campaign,
      payer
    }) {
      const id = campaignIdentity({
        genesisHash,
        programId,
        campaign
      });
      if (!isAddress(payer)) throw Error('Invalid payer');
      return rowToBudget(await get(SQL.budgetGet, [id.genesisHash, id.programId, id.campaign, payer]));
    },
    /** Writes the three counters of one (campaign, payer) row; the caller computes them inside a transaction. */
    async put({
      genesisHash,
      programId,
      campaign,
      payer,
      reservedLamports,
      spentLamports,
      returnedLamports,
      policy
    }) {
      const id = campaignIdentity({
        genesisHash,
        programId,
        campaign
      });
      if (!isAddress(payer)) throw Error('Invalid payer');
      const r = optDecimal(reservedLamports, 'reservedLamports'),
        s = optDecimal(spentLamports, 'spentLamports'),
        b = optDecimal(returnedLamports, 'returnedLamports');
      if (r == null || s == null || b == null) throw Error('Budget counters are required');
      if (typeof policy !== 'string' || !KEY.test(policy)) throw Error('Invalid budget policy');
      if(BigInt(s)+BigInt(b)>BigInt(r))throw Error('Budget spends and returns exceed reservation');
      return await transaction(async () => {
        const at = isoNow(now);
        if (await get(SQL.budgetGet, [id.genesisHash, id.programId, id.campaign, payer])) await run(SQL.budgetUpdate, [r, s, b, policy, at, id.genesisHash, id.programId, id.campaign, payer]);else await run(SQL.budgetInsert, [id.genesisHash, id.programId, id.campaign, payer, r, s, b, policy, at]);
        return rowToBudget(await get(SQL.budgetGet, [id.genesisHash, id.programId, id.campaign, payer]));
      });
    }
  };
  const mintLeases = {
    /** Inserts a reserved lease. UNIQUE(mint) and UNIQUE(creator, idempotency_key) make a double reservation impossible. */
    async insert({
      mint,
      genesisHash = null,
      programId = null,
      campaign = null,
      creator,
      network,
      draftId,
      idempotencyKey,
      signerRef = null
    }) {
      if (!isAddress(mint)) throw Error('Invalid mint');
      if (!isAddress(creator)) throw Error('Invalid creator');
      optAddress(genesisHash, 'genesisHash');
      optAddress(programId, 'programId');
      optAddress(campaign, 'campaign');
      if (!['localnet', 'devnet', 'mainnet'].includes(network)) throw Error('network must be localnet, devnet or mainnet');
      if (typeof draftId !== 'string' || !KEY.test(draftId)) throw Error('Invalid draft id');
      if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey)) throw Error('Invalid idempotency key');
      optText(signerRef, 'signerRef', 200);
      return await transaction(async () => {
        const at = isoNow(now),
          leaseId = randomUUID();
        await run(SQL.leaseInsert, [leaseId, mint, genesisHash, programId, campaign, creator, 'reserved', signerRef, at, at, network, draftId, idempotencyKey]);
        return rowToLease(await get(SQL.leaseGet, [leaseId]));
      });
    },
    async get(leaseId) {
      return rowToLease(await get(SQL.leaseGet, [leaseId]));
    },
    async byBinding({
      creator,
      idempotencyKey
    }) {
      return rowToLease(await get(SQL.leaseByBinding, [creator, idempotencyKey]));
    },
    async byMint(mint) {
      return rowToLease(await get(SQL.leaseByMint, [mint]));
    },
    /** Compare-and-set on the state: the row moves from `from` to `to` (fields kept unless given) or the call returns null. */
    async transition({
      leaseId,
      from,
      to,
      messageDigest,
      signature,
      reason
    }) {
      if (!MINT_LEASE_STATES.includes(from) || !MINT_LEASE_STATES.includes(to)) throw Error('Unknown lease state');
      assertMintTransition(from,to);
      return await transaction(async () => {
        const row = rowToLease(await get(SQL.leaseGet, [leaseId]));
        if (!row || row.state !== from) return null;
        if(row.messageDigest!=null&&messageDigest!==undefined&&messageDigest!==row.messageDigest)return null;
        if(row.signature!=null&&signature!==undefined&&signature!==row.signature)return null;
        const digest = messageDigest === undefined ? row.messageDigest : messageDigest,
          sig = signature === undefined ? row.signature : signature,
          why = reason === undefined ? row.reason : reason;
        if (digest != null && !HEX64.test(digest)) throw Error('messageDigest must be a sha256 hex');
        if (sig != null && !SIGNATURE.test(sig)) throw Error('Invalid signature');
        optText(why, 'reason', 200);
        if (Number((await run(SQL.leaseUpdate, [to, digest, sig, why, isoNow(now), leaseId, from])).changes) !== 1) return null;
        return rowToLease(await get(SQL.leaseGet, [leaseId]));
      });
    },
    /** A released mint goes back to stock; when the inventory hands it out again the same row is rebound to the new binding
     * (UNIQUE(mint) keeps one row per mint). Only a released row can be rebound. The reason records the previous lease. */
    async rebind({
      leaseId,
      mint,
      genesisHash = null,
      programId = null,
      campaign = null,
      creator,
      network,
      draftId,
      idempotencyKey,
      signerRef = null
    }) {
      if (!isAddress(mint)) throw Error('Invalid mint');
      if (!isAddress(creator)) throw Error('Invalid creator');
      optAddress(genesisHash, 'genesisHash');
      optAddress(programId, 'programId');
      optAddress(campaign, 'campaign');
      if (!['localnet', 'devnet', 'mainnet'].includes(network)) throw Error('network must be localnet, devnet or mainnet');
      if (typeof draftId !== 'string' || !KEY.test(draftId)) throw Error('Invalid draft id');
      if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey)) throw Error('Invalid idempotency key');
      return await transaction(async () => {
        const row = rowToLease(await get(SQL.leaseGet, [leaseId]));
        if (!row || row.state !== 'released' || row.mint !== mint) return null;
        const nextId=randomUUID();const reason=('rebound; previous lease '+row.leaseId).slice(0,200);
        if (Number((await run(SQL.leaseRebind, [nextId, genesisHash, programId, campaign, creator, signerRef, isoNow(now), network, draftId, idempotencyKey, reason, leaseId])).changes) !== 1) return null;
        return rowToLease(await get(SQL.leaseGet, [nextId]));
      });
    },
    async counts() {
      const out = {};
      for (const s of MINT_LEASE_STATES) out[s] = 0;
      for (const r of await all(SQL.leaseCounts, [])) out[r.state] = Number(r.n);
      return out;
    },
    async list({
      state,
      limit = DEFAULT_PAGE
    }) {
      if (!MINT_LEASE_STATES.includes(state)) throw Error('Unknown lease state');
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('limit must be 1..1000');
      return (await all(SQL.leaseList, [state, limit])).map(rowToLease);
    }
  };
  const chainEvents = {
    /** Idempotent on (genesis, signature, instruction path, kind): a repeat changes nothing except a finalized status or a late block time. */
    async record({
      genesisHash,
      signature,
      instructionPath,
      kind,
      programId = null,
      campaign = null,
      slot,
      blockTime = null,
      status = 'confirmed',
      asset = null,
      payload = null
    }) {
      if (!isAddress(genesisHash)) throw Error('Invalid genesis hash');
      if (!SIGNATURE.test(signature || '')) throw Error('Invalid signature');
      if (!PATH.test(instructionPath || '')) throw Error('Invalid instruction path');
      if (typeof kind !== 'string' || !KEY.test(kind)) throw Error('Invalid event kind');
      if (!Number.isSafeInteger(slot) || slot < 0) throw Error('Invalid slot');
      if (blockTime != null && (!Number.isSafeInteger(blockTime) || blockTime <= 0)) throw Error('Invalid block time');
      if (!EVENT_STATUSES.includes(status)) throw Error('Invalid event status');
      optAddress(programId, 'programId');
      optAddress(campaign, 'campaign');
      return await transaction(async () => {
        const before = await get(SQL.eventGet, [genesisHash, signature, instructionPath, kind]);
        await run(SQL.eventInsert, [genesisHash, signature, instructionPath, kind, programId, campaign, slot, blockTime, status, asset == null ? null : canonicalJson(asset), payload == null ? null : canonicalJson(payload), isoNow(now)]);
        return {
          inserted: !before,
          event: rowToEvent(await get(SQL.eventGet, [genesisHash, signature, instructionPath, kind]))
        };
      });
    },
    async list({
      genesisHash,
      programId,
      campaign,
      limit = DEFAULT_PAGE
    }) {
      const id = campaignIdentity({
        genesisHash,
        programId,
        campaign
      });
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw Error('limit must be 1..' + MAX_PAGE);
      return (await all(SQL.eventList, [id.genesisHash, id.programId, id.campaign, limit])).map(rowToEvent);
    }
  };
  const draftRow = r => r ? {
    id: r.draft_id,
    creator: r.creator,
    revision: r.revision,
    status: r.status,
    body: JSON.parse(r.body_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  } : null;
  const drafts = {
    async get(creator, id) {
      if (!isAddress(creator) || !KEY.test(id || '')) throw Error('Invalid draft identity');
      return draftRow(await get('SELECT * FROM creator_drafts WHERE creator=? AND draft_id=?', [creator, id]));
    },
    async list(creator) {
      if (!isAddress(creator)) throw Error('Invalid creator');
      return (await all('SELECT * FROM creator_drafts WHERE creator=? ORDER BY updated_at DESC LIMIT 100', [creator])).map(draftRow);
    },
    async save({
      creator,
      id,
      revision,
      body
    }) {
      if (!isAddress(creator) || !KEY.test(id || '')) throw Error('Invalid draft identity');
      if (!Number.isSafeInteger(revision) || revision < 0) throw Error('Draft revision required');
      const json = canonicalJson(body);
      if (Buffer.byteLength(json) > 100000) throw Error('Draft too large');
      return await transaction(async () => {
        const prior = await drafts.get(creator, id);
        if ((prior?.revision || 0) !== revision) {
          const e = Error('Draft changed in another tab. Reload before saving.');
          e.code = 'REVISION_CONFLICT';
          throw e;
        }
        if (prior && prior.status !== 'draft') throw Error('A published draft cannot be edited');
        if (!prior && (await drafts.list(creator)).length >= 100) throw Error('Draft limit reached');
        const at = isoNow(now);
        if (prior) await run('UPDATE creator_drafts SET body_json=?,revision=?,updated_at=? WHERE creator=? AND draft_id=? AND revision=?', [json, revision + 1, at, creator, id, revision]);else await run('INSERT INTO creator_drafts(creator,draft_id,revision,status,body_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [creator, id, 1, 'draft', json, at, at]);
        return await drafts.get(creator, id);
      });
    }
  };
  const packetRow = r => r ? {
    id: r.id,
    owner: r.owner,
    campaignId: r.campaign_id,
    requestKey: r.request_key,
    descriptor: r.descriptor,
    prepared: JSON.parse(r.prepared_json),
    signedBase64: r.signed_base64,
    signature: r.signature,
    status: r.status,
    error: r.error,
    createdAt: r.created_at
  } : null;
  const walletPackets = {
    async get(id) {
      return packetRow(await get('SELECT * FROM wallet_packets WHERE id=?', [id]));
    },
    async list(owner) {
      if (!isAddress(owner)) throw Error('Invalid wallet');
      return (await all('SELECT * FROM wallet_packets WHERE owner=? ORDER BY updated_at DESC LIMIT 50', [owner])).map(packetRow);
    },
    async pending(owner) {
      if (!isAddress(owner)) throw Error('Invalid wallet');
      return (await all("SELECT * FROM wallet_packets WHERE owner=? AND status NOT IN ('confirmed','finalized','failed','expired','cancelled') ORDER BY created_at ASC LIMIT 50", [owner])).map(packetRow);
    },
    async find(owner, campaignId, key) {
      return packetRow(await get('SELECT * FROM wallet_packets WHERE owner=? AND campaign_id=? AND request_key=?', [owner, campaignId, key]));
    },
    async prepare({
      owner,
      campaignId,
      requestKey,
      descriptor,
      prepared
    }) {
      if (!isAddress(owner) || !KEY.test(requestKey || '') || typeof campaignId !== 'string' || campaignId.length > 160) throw Error('Invalid transaction identity');
      return await transaction(async () => {
        const prior = await walletPackets.find(owner, campaignId, requestKey);
        if (prior) {
          if (prior.descriptor !== descriptor) {
            const e = Error('Request ID already belongs to different parameters');
            e.code = 'IDEMPOTENCY_CONFLICT';
            throw e;
          }
          return prior;
        }
        if ((await walletPackets.pending(owner)).length >= 16) throw Object.assign(Error('Resolve pending transactions before starting another'), {
          publicMessage: 'Resolve pending transactions before starting another'
        });
        const id = randomUUID(),
          at = isoNow(now);
        await run('INSERT INTO wallet_packets(id,owner,campaign_id,request_key,descriptor,prepared_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [id, owner, campaignId, requestKey, descriptor, canonicalJson(prepared), 'prepared', at, at]);
        return await walletPackets.get(id);
      });
    },
    async sign({
      id,
      owner,
      signedBase64,
      signature
    }) {
      return await transaction(async () => {
        const p = await walletPackets.get(id);
        if (!p || p.owner !== owner) throw Error('Transaction not found');
        if (p.signedBase64) {
          if (p.signedBase64 !== signedBase64 || p.signature !== signature) throw Error('Transaction was already signed differently');
          return p;
        }
        if (p.status !== 'prepared') throw Error('Transaction is no longer signable');
        await run('UPDATE wallet_packets SET signed_base64=?,signature=?,status=?,updated_at=? WHERE id=? AND signed_base64 IS NULL', [signedBase64, signature, 'signed', isoNow(now), id]);
        return await walletPackets.get(id);
      });
    },
    async cancel(id, owner) {
      await run("UPDATE wallet_packets SET status='cancelled',updated_at=? WHERE id=? AND owner=? AND status='prepared' AND signed_base64 IS NULL", [isoNow(now), id, owner]);
      return await walletPackets.get(id);
    },
    async progress(id, status, error = null, {expectedStatus=null} = {}) {
      if (!['submitted', 'unknown', 'confirmed', 'finalized', 'failed', 'expired'].includes(status)) throw Error('Invalid packet state');
      // Never downgrade known success, or change the packet/signature during retries.
      await run("UPDATE wallet_packets SET status=?,error=?,updated_at=? WHERE id=? AND status NOT IN ('finalized','cancelled') AND (status<>'confirmed' OR ?='finalized') AND (CAST(? AS TEXT) IS NULL OR status=?)", [status, error, isoNow(now), id,status,expectedStatus,expectedStatus]);
      return await walletPackets.get(id);
    }
  };
  return {
    campaigns,
    intents,
    jobs,
    chainEvents,
    capabilities,
    budgets,
    mintLeases,
    drafts,
    walletPackets
  };
}
/** node:sqlite adapter. `path` ':memory:' for tests; on the API volume otherwise (directory created 0700). */

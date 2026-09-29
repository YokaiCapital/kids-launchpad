"""KIDS community worker: refresh the believers list and wallet proofs, push to the KIDS API. One run per invocation."""
import xapi, classify, json, os, re, sys, time, urllib.request
from datetime import datetime, timezone

WORK = xapi.WORK
OWNER = os.environ.get("OWNER_ID", "1851449314163273728")
WATCH = [p for p in os.environ.get("WATCH_POSTS", "").split(",") if p.strip()]
ASK = {p for p in os.environ.get("ASK_POSTS", "").split(",") if p.strip()}
PINNED = os.environ.get("PINNED_WALLET_POST", "").strip()
API = os.environ.get("KIDS_API_URL", "").rstrip("/")
TOKEN = os.environ.get("KIDS_COMMUNITY_TOKEN", "")
UF = "id,username,name,public_metrics"
TF = "id,text,author_id,created_at,in_reply_to_user_id,referenced_tweets"
now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
today = now[:10]

def path(n): return os.path.join(WORK, n)
def load(n, d):
    try: return json.load(open(path(n)))
    except Exception: return d
def save(n, o): json.dump(o, open(path(n), "w"), indent=1, ensure_ascii=False)
def log(msg):
    line = f"{now} {msg}"; print(line, flush=True); open(path("run.log"), "a").write(line + "\n")

state = load("state.json", {"seen": {}, "blocklist": []})
sup = load("supporters.json", {"generatedAt": now, "entries": []})
entries = {e["xId"]: e for e in sup["entries"]}
users = {}
block = {b.lower() for b in state.get("blocklist", [])} | {b.lower() for b in os.environ.get("BLOCKLIST", "").split(",") if b}

def add(uid, how):
    if uid == OWNER or uid not in users or users[uid]["username"].lower() in block: return
    u = users[uid]; m = u.get("public_metrics", {})
    e = entries.get(uid)
    if not e:
        e = entries[uid] = {"xId": uid, "username": u["username"][:32], "name": (u.get("name") or None), "followers": m.get("followers_count", 0), "how": [], "since": today}
    e["username"] = u["username"][:32]; e["name"] = (u.get("name") or None); e["followers"] = m.get("followers_count", 0)
    if how not in e["how"]: e["how"].append(how)

def seen(key): return set(state["seen"].get(key, []))
def mark(key, ids): state["seen"][key] = sorted(set(state["seen"].get(key, [])) | set(ids))[-20000:]

calls = 0
def fetch(key, path_, q, item_key="data", pages=10, stop_when_seen=True):
    """Newest first from X; stop paging once a whole page is already seen."""
    global calls
    out, token, old = [], None, seen(key)
    for _ in range(pages):
        qq = dict(q)
        if token: qq["pagination_token"] = token
        st, j, h = xapi.call("GET", path_, qq); calls += 1
        if st != 200:
            log(f"{key}: {st} {json.dumps(j)[:120]}"); break
        for u in (j.get("includes", {}) or {}).get("users", []) or []: users[u["id"]] = u
        page = j.get(item_key, []) or []
        for it in page:
            if it["id"] not in old: out.append(it)
        if not page or (stop_when_seen and all(it["id"] in old for it in page)): break
        token = (j.get("meta") or {}).get("next_token")
        if not token: break
    mark(key, [it["id"] for it in out])
    return out

total_new = 0
for post in WATCH:
    ctx = f"post {post}"
    likers = fetch(f"likes:{post}", f"/2/tweets/{post}/liking_users", {"max_results": 100, "user.fields": UF})
    for u in likers:
        users[u["id"]] = u
        if post in ASK: add(u["id"], "liked the ask")
    rts = fetch(f"rts:{post}", f"/2/tweets/{post}/retweeted_by", {"max_results": 100, "user.fields": UF})
    for u in rts: users[u["id"]] = u; add(u["id"], "retweeted")
    reps = fetch(f"replies:{post}", "/2/tweets/search/recent", {"query": f"conversation_id:{post}", "max_results": 100, "tweet.fields": TF, "expansions": "author_id", "user.fields": UF})
    for t in reps:
        if t["author_id"] == OWNER or t.get("in_reply_to_user_id") != OWNER: continue
        ok, why = classify.supportive(t["text"], ctx)
        if ok: add(t["author_id"], "answered the ask" if post in ASK else "agreed in a reply")
    qts = fetch(f"quotes:{post}", f"/2/tweets/{post}/quote_tweets", {"max_results": 100, "tweet.fields": TF, "expansions": "author_id", "user.fields": UF}, pages=2)
    for t in qts:
        if t["author_id"] == OWNER: continue
        txt = re.sub(r"https://t\.co/\S+", "", t["text"]).strip()
        if txt.startswith("RT @"):
            continue                        # a retweet of someone else's quote: not their own words
        if not txt:
            continue                        # image-only quote: cannot judge, never counted
        ok, why = classify.supportive(txt, ctx)
        if ok: add(t["author_id"], "agreed in a quote")
    total_new += len(likers) + len(rts) + len(reps) + len(qts)

# wallet proofs from the pinned post
wallets = load("supporter-wallets.json", {"generatedAt": now, "entries": []})
have = {w["xId"] for w in wallets["entries"]}
if PINNED:
    reps = fetch(f"wallets:{PINNED}", "/2/tweets/search/recent", {"query": f"conversation_id:{PINNED}", "max_results": 100, "tweet.fields": TF, "expansions": "author_id", "user.fields": UF}, stop_when_seen=False)
    reps.sort(key=lambda t: t["created_at"])          # first valid reply wins
    for t in reps:
        a = t["author_id"]
        if a == OWNER or a in have or a not in entries or t.get("in_reply_to_user_id") != OWNER: continue
        cands = re.findall(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b", t["text"])
        if len(cands) != 1: continue
        w = cands[0]
        try:
            import base58_oncurve
            if not base58_oncurve.is_wallet(w): continue
        except Exception:
            pass                                       # helper missing: accept format-valid only, flagged in log
        wallets["entries"].append({"xId": a, "wallet": w, "provedAt": t["created_at"], "tweetUrl": f"https://x.com/{entries[a]['username']}/status/{t['id']}"})
        have.add(a)

sup = {"generatedAt": now, "source": "x-outreach worker", "entries": sorted(entries.values(), key=lambda e: (e["since"], -e["followers"]))}
wallets["generatedAt"] = now
save("supporters.json", sup); save("supporter-wallets.json", wallets); save("state.json", state)

def push(route, obj):
    if not API or not TOKEN: return "skipped (no API url or token)"
    req = urllib.request.Request(f"{API}{route}", data=json.dumps(obj).encode(), method="POST",
                                 headers={"x-kids-community-token": TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30, context=xapi.SSL_CTX) as r: return str(r.status)
    except urllib.error.HTTPError as e: return f"{e.code} {e.read().decode(errors='replace')[:100]}"
    except Exception as e: return f"error {str(e)[:80]}"

r1 = push("/api/community/supporters", sup); r2 = push("/api/community/supporter-wallets", wallets)
log(f"posts={len(WATCH)} new_items={total_new} supporters={len(sup['entries'])} wallets={len(wallets['entries'])} x_calls={calls} push_supporters={r1} push_wallets={r2}")

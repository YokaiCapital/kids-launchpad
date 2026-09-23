#!/usr/bin/env python3
"""Minimal X API v2 client with OAuth 1.0a user context (stdlib only). Never prints secrets."""
import base64, hashlib, hmac, json, os, sys, time, urllib.parse, urllib.request, uuid, random, ssl
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem')

ENV_PATH = None
WORK = os.environ.get("WORK_DIR", "/data")

def load_env():
    """Container build: X credentials come from environment variables only."""
    return {k: v for k, v in os.environ.items() if k.startswith("X_")}

ENV = load_env()
CK, CS = ENV.get("X_CONSUMER_KEY", ""), ENV.get("X_CONSUMER_SECRET", "")
AT, ATS = ENV.get("X_ACCESS_TOKEN", ""), ENV.get("X_ACCESS_TOKEN_SECRET", "")
BEARER = ENV.get("X_API_BEARER_TOKEN2") or ENV.get("X_API_BEARER_TOKEN", "")

def pct(s):
    return urllib.parse.quote(str(s), safe="-._~")

def oauth_header(method, url, query=None):
    query = query or {}
    oauth = {
        "oauth_consumer_key": CK,
        "oauth_nonce": uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": AT,
        "oauth_version": "1.0",
    }
    params = dict(query); params.update(oauth)
    base_params = "&".join(f"{pct(k)}={pct(v)}" for k, v in sorted(params.items()))
    base = f"{method.upper()}&{pct(url)}&{pct(base_params)}"
    key = f"{pct(CS)}&{pct(ATS)}".encode()
    sig = base64.b64encode(hmac.new(key, base.encode(), hashlib.sha1).digest()).decode()
    oauth["oauth_signature"] = sig
    return "OAuth " + ", ".join(f'{pct(k)}="{pct(v)}"' for k, v in sorted(oauth.items()))

def call(method, path, query=None, body=None, auth="user", max_attempts=4):
    url = "https://api.x.com" + path
    query = {k: v for k, v in (query or {}).items() if v is not None}
    full = url + ("?" + urllib.parse.urlencode(query) if query else "")
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(1, max_attempts + 1):
        headers = {"User-Agent": "yokai-outreach/1.0"}
        if auth == "user":
            headers["Authorization"] = oauth_header(method, url, query)
        elif auth == "oauth2":
            headers["Authorization"] = "Bearer " + ENV.get("X_OAUTH2_ACCESS_TOKEN", "")
        else:
            headers["Authorization"] = f"Bearer {BEARER}"
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(full, data=data, method=method.upper(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
                txt = r.read().decode()
                return r.status, (json.loads(txt) if txt else {}), dict(r.headers)
        except urllib.error.HTTPError as e:
            txt = e.read().decode(errors="replace")
            try: j = json.loads(txt)
            except Exception: j = {"raw": txt[:500]}
            hdrs = dict(e.headers)
            if e.code == 429 and attempt < max_attempts:
                reset = hdrs.get("x-rate-limit-reset")
                wait = max(5, int(reset) - int(time.time()) + 2) if reset else 60
                wait = min(wait, 900)
                print(f"  429 rate limited on {path}; sleeping {wait}s (attempt {attempt})", file=sys.stderr, flush=True)
                time.sleep(wait); continue
            if e.code >= 500 and attempt < max_attempts:
                time.sleep(2 ** attempt + random.random()); continue
            return e.code, j, hdrs
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:   # includes RemoteDisconnected
            if attempt < max_attempts:
                time.sleep(2 ** attempt + random.random()); continue
            return 0, {"error": str(e)}, {}

def paginate(path, query, key="data", auth="user", limit_pages=200):
    out, includes, token = [], {"users": []}, None
    for _ in range(limit_pages):
        q = dict(query)
        if token: q["pagination_token"] = token
        st, j, h = call("GET", path, q, auth=auth)
        if st != 200:
            print(f"  {path} -> {st} {json.dumps(j)[:300]}", file=sys.stderr, flush=True)
            return out, includes, {"status": st, "body": j}
        out.extend(j.get(key, []) or [])
        for u in (j.get("includes", {}) or {}).get("users", []) or []:
            includes["users"].append(u)
        token = (j.get("meta", {}) or {}).get("next_token")
        if not token: break
    return out, includes, None

def save(name, obj):
    with open(os.path.join(WORK, name), "w") as f:
        json.dump(obj, f, indent=1)

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "me"
    if cmd == "me":
        st, j, h = call("GET", "/2/users/me", {"user.fields": "id,username,name,public_metrics"})
        print("user-context /2/users/me ->", st, json.dumps(j))
        st, j, h = call("GET", "/2/tweets/2101747601494147202", {"tweet.fields": "public_metrics,created_at"}, auth="bearer")
        print("bearer /2/tweets/:id ->", st, json.dumps(j)[:400])
        st, j, h = call("GET", "/1.1/account/verify_credentials.json", {"skip_status": "true"})
        print("user-context v1.1 verify_credentials ->", st, json.dumps(j)[:300])
        print("rate headers:", {k: v for k, v in h.items() if k.lower().startswith("x-rate")})

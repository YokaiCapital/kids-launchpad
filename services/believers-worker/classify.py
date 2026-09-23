"""Is this reply or quote supportive of the KIDS initiative? Rules only; an unsure reply is never counted as support."""
import os, re, json, urllib.request

POS = [
    r"\bagree", r"\bfacts?\b", r"\btrue\b", r"\breal\b", r"\bbased\b", r"\blegend", r"\brespect", r"\bthank",
    r"\bwell said", r"\bgood (read|post|thread|take|work|share)", r"\bgreat (read|post|thread|take|work)",
    r"\bcount me in", r"\bi'?m in\b", r"\bim in\b", r"\bwith you\b", r"\bsupport", r"\blet'?s (go|do)", r"\blfg\b",
    r"\bdo it\b", r"\bship it", r"\byes\b", r"\b100\s?%", r"\bfinally\b", r"\bexactly\b", r"\bthis\.?$", r"\bbookmark",
    r"\bneeded\b", r"\bdeserve", r"\bspot on", r"\bnot wrong", r"\bknew it", r"\bwe see you", r"\bkilled\b",
    r"\bexit liquidity", r"\bcabal", r"\binsiders?\b", r"\bfair launch", r"\bno (bonding )?curve", r"\bcleans",
    r"\bheal", r"\bhero", r"\btired of (losing|this)", r"\bkids\b", r"\bshartcoin", r"🫡", r"🔥", r"💯", r"🙏",
]
NEG = [
    r"\bscammer\b.*\byou\b", r"\byou.*\brug", r"\bcope\b", r"\bschizo", r"\bmeds\b", r"\bseek help", r"\bretard",
    r"\bfud\b", r"\bfake\b.*\bpost", r"\bengagement farm", r"\bnobody cares", r"\bshut (up|the)", r"\bclown",
    r"\bliar\b", r"\bbullshit\b", r"\bbs\b", r"\bnonsense", r"\bdumb\b", r"\bidiot", r"\bloser", r"\bjealous",
    r"\bpot calling", r"\bhypocri", r"\bfaggot|\bnigg|\bjoo", r"\bkys\b",
]
SHILL = [
    r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b", r"\$[A-Z]{2,10}\b.*\b(fix|solve|save|answer)", r"\bcheck out\b", r"\bjoin\b.*\bcommunity",
    r"\bairdrop", r"\bgiveaway", r"\bdrop (your )?(wallet|addy)", r"\bfollow @", r"\bpresale", r"\bwhitelist",
]
def rules(text):
    t = text.lower()
    if any(re.search(p, t, re.I) for p in SHILL): return "no", "shill"
    neg = sum(bool(re.search(p, t, re.I)) for p in NEG)
    pos = sum(bool(re.search(p, t, re.I)) for p in POS)
    if neg and not pos: return "no", "hostile"
    if pos and not neg: return "yes", "positive"
    if pos and neg: return "unsure", "mixed"
    if len(t.split()) <= 2: return "no", "too short"
    return "unsure", "neutral"

def supportive(text, context=""):
    v, why = rules(text)
    if v == "unsure":
        return False, f"unsure:{why}"        # unsure means not counted (never invent support)
    return v == "yes", why

"""Is a base58 string a 32-byte ed25519 point on the curve (a real wallet key, not a program-derived address)?"""
ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
P = 2**255 - 19
D = (-121665 * pow(121666, P - 2, P)) % P
I = pow(2, (P - 1) // 4, P)

def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + ALPHA.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + raw

def on_curve(b):
    if len(b) != 32: return False
    y = int.from_bytes(b, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= P: return False
    u = (y * y - 1) % P
    v = (D * y * y + 1) % P
    xx = (u * pow(v, P - 2, P)) % P
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = (x * I) % P
    if (x * x - xx) % P != 0:
        return False
    if x == 0 and sign == 1:
        return False
    return True

def is_wallet(addr):
    try:
        return on_curve(b58decode(addr))
    except Exception:
        return False

if __name__ == "__main__":
    # system program (on curve, all zeros is a valid point y=0? no: y=0 gives x^2 = -1 which has a root, so on curve) and a known PDA
    print("wallet-like:", is_wallet("11111111111111111111111111111111"))
    print("token program (on curve):", is_wallet("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))

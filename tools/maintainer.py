#!/usr/bin/env python3
"""
Maintainer tool for end-to-end encrypted help requests.   pip install cryptography

  python tools/maintainer.py keygen  [--out maintainer_private.pem]
      Makes the maintainer key pair. Prints the PUBLIC key (put it in frontend/.env.local as
      VITE_MAINTAINER_PUBKEY) and its fingerprint (publish it in the README so users can verify it).
      The private .pem never leaves your machine and is git-ignored. Back it up offline.

  python tools/maintainer.py inbox   --url https://<worker>  [--key maintainer_private.pem]
      Downloads and decrypts private requests. Needs env MAINTAINER_TOKEN.

  python tools/maintainer.py reply   --url https://<worker> --id <request id> --to <reply_pub from the request> --text "..."
      Encrypts a reply that only the requesting device can read.

Scheme (identical to frontend/src/crypto.ts): ephemeral ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

SALT = b"rgap-e2ee-v1-salt"
INFO = b"rgap-e2ee-v1"
AAD = b"rgap-v1"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def raw_public(pub: ec.EllipticCurvePublicKey) -> bytes:
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def load_public(b64_text: str) -> ec.EllipticCurvePublicKey:
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(b64_text))


def derive(private: ec.EllipticCurvePrivateKey, public: ec.EllipticCurvePublicKey) -> bytes:
    shared = private.exchange(ec.ECDH(), public)
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=SALT, info=INFO).derive(shared)


def seal(recipient_pub_b64: str, text: str) -> dict:
    eph = ec.generate_private_key(ec.SECP256R1())
    key = derive(eph, load_public(recipient_pub_b64))
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, text.encode(), AAD)
    return {"v": 1, "epk": b64(raw_public(eph.public_key())), "iv": b64(iv), "ct": b64(ct)}


def open_envelope(private: ec.EllipticCurvePrivateKey, env: dict) -> str:
    key = derive(private, load_public(env["epk"]))
    return AESGCM(key).decrypt(base64.b64decode(env["iv"]), base64.b64decode(env["ct"]), AAD).decode()


def fingerprint(pub_b64: str) -> str:
    h = hashlib.sha256(base64.b64decode(pub_b64)).hexdigest().upper()[:16]
    return "-".join(h[i : i + 4] for i in range(0, 16, 4))


def http(method: str, url: str, body: dict | None = None) -> dict:
    token = os.environ.get("MAINTAINER_TOKEN", "")
    if not token:
        sys.exit("Set the MAINTAINER_TOKEN environment variable first.")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "rgap-maintainer/1.0")  # Cloudflare rejects the default urllib agent
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def load_private(path: str) -> ec.EllipticCurvePrivateKey:
    with open(path, "rb") as fh:
        return serialization.load_pem_private_key(fh.read(), password=None)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keygen")
    k.add_argument("--out", default="maintainer_private.pem")
    i = sub.add_parser("inbox")
    i.add_argument("--url", required=True)
    i.add_argument("--key", default="maintainer_private.pem")
    r = sub.add_parser("reply")
    r.add_argument("--url", required=True)
    r.add_argument("--id", required=True)
    r.add_argument("--to", required=True)
    r.add_argument("--text", required=True)
    args = ap.parse_args()

    if args.cmd == "keygen":
        if os.path.exists(args.out):
            sys.exit(f"{args.out} already exists. Refusing to overwrite.")
        private = ec.generate_private_key(ec.SECP256R1())
        pem = private.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(pem)
        pub = b64(raw_public(private.public_key()))
        print(f"Private key written to {args.out} (keep it offline, back it up, never commit it).")
        print(f"VITE_MAINTAINER_PUBKEY={pub}")
        print(f"Fingerprint to publish: {fingerprint(pub)}")
    elif args.cmd == "inbox":
        private = load_private(args.key)
        for item in http("GET", args.url.rstrip("/") + "/api/maintainer/inbox")["items"]:
            try:
                print(f"--- request {item['id']}")
                print(json.dumps(json.loads(open_envelope(private, item["envelope"])), indent=2))
            except Exception as exc:  # tampered, or encrypted to a different key
                print(f"(could not decrypt: {exc.__class__.__name__})")
    elif args.cmd == "reply":
        env = seal(args.to, args.text)
        http("POST", args.url.rstrip("/") + "/api/maintainer/reply", {"id": args.id, "envelope": env})
        print("Encrypted reply stored.")


if __name__ == "__main__":
    main()

"""HTTPS for the LAN.

Browsers only allow camera access on secure pages, so the host serves HTTPS.
A small local certificate authority is created once; its certificate can be
installed on a phone (served at http://<host>:8080/ca.crt) for a warning-free
connection. Without that, accepting the browser warning once also works.
The server certificate is reissued whenever the LAN address changes.
"""

from __future__ import annotations

import datetime as dt
import ipaddress
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def _write_key(key, path: Path) -> None:
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    path.chmod(0o600)


def _load_or_create_ca(d: Path):
    key_path, crt_path = d / "ca.key", d / "ca.crt"
    if key_path.exists() and crt_path.exists():
        key = serialization.load_pem_private_key(key_path.read_bytes(), None)
        return key, x509.load_pem_x509_certificate(crt_path.read_bytes())
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Seefy local CA")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_cert_sign=True, crl_sign=True,
                content_commitment=False, key_encipherment=False, data_encipherment=False,
                key_agreement=False, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    _write_key(key, key_path)
    crt_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return key, cert


def _covers(cert: x509.Certificate, names: list[str], ips: list[str]) -> bool:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return False
    have_dns = set(san.get_values_for_type(x509.DNSName))
    have_ip = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
    remaining = cert.not_valid_after_utc - dt.datetime.now(dt.timezone.utc)
    return set(names) <= have_dns and set(ips) <= have_ip and remaining > dt.timedelta(days=30)


def ensure_certs(d: Path, names: list[str], ips: list[str]) -> tuple[Path, Path, Path]:
    """Return (server cert, server key, CA cert) paths, creating or reissuing as needed."""
    d.mkdir(parents=True, exist_ok=True)
    ca_key, ca_cert = _load_or_create_ca(d)
    crt_path, key_path = d / "server.crt", d / "server.key"
    if crt_path.exists() and key_path.exists():
        if _covers(x509.load_pem_x509_certificate(crt_path.read_bytes()), names, ips):
            return crt_path, key_path, d / "ca.crt"

    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    san = [x509.DNSName(n) for n in names] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        # Apple rejects server certificates valid for more than 825 days.
        .not_valid_after(now + dt.timedelta(days=800))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    _write_key(key, key_path)
    crt_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return crt_path, key_path, d / "ca.crt"

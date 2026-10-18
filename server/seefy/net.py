"""Local network helpers: LAN address, hostnames, MAC lookup, mDNS."""

from __future__ import annotations

import re
import socket
import subprocess

from zeroconf import ServiceInfo, Zeroconf


def lan_ip() -> str:
    # Connecting a UDP socket sends nothing; it just picks the outgoing interface.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def local_hostname() -> str:
    name = socket.gethostname().split(".")[0]
    return f"{name}.local"


def mac_for_ip(ip: str) -> str | None:
    """Look up a LAN device's MAC address in the ARP table (used to tell nodes which phone to sniff)."""
    try:
        out = subprocess.run(["arp", "-n", ip], capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"(([0-9a-f]{1,2}:){5}[0-9a-f]{1,2})", out, re.I)
    if not m:
        return None
    return ":".join(part.zfill(2) for part in m.group(1).lower().split(":"))


class MdnsAdvertiser:
    """Advertises seefy.local so phones and nodes can find the host without an IP."""

    def __init__(self, ip: str, port: int, name: str = "seefy"):
        self.zc = Zeroconf()
        self.info = ServiceInfo(
            "_https._tcp.local.",
            f"{name}._https._tcp.local.",
            addresses=[socket.inet_aton(ip)],
            port=port,
            server=f"{name}.local.",
            properties={"path": "/"},
        )

    def start(self) -> None:
        self.zc.register_service(self.info, allow_name_change=True)

    def stop(self) -> None:
        self.zc.unregister_service(self.info)
        self.zc.close()

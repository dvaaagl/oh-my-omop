#!/usr/bin/env python3
"""Cloudflare origin-IP finder — stdlib only.

When a domain is behind Cloudflare, the real origin sometimes leaks via:
  - certificate SANs on the origin's own TLS cert
  - host-header routing (origin responds to Host: <domain>)
  - historical DNS / CT logs

This script tests candidate IPs (from a list or the domain's A/AAAA history you
supply) by connecting directly and sending Host: <domain>, then comparing the
served content / cert CN against the Cloudflare-fronted response.

Usage:
  python cf_origin_finder.py example.com
  python cf_origin_finder.py example.com --ip 1.2.3.4 --ip 5.6.7.8
  python cf_origin_finder.py example.com --range 43.134.64.0/24   (small ranges only)
"""
import sys, re, ssl, socket, json, ipaddress
import urllib.request


def get_cf_front(dom):
    try:
        req = urllib.request.Request("https://%s/" % dom,
                                     headers={"User-Agent": "Mozilla/5.0"})
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            return r.status, r.read(60000).decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def get_origin_cert_cn(ip, dom, timeout=8):
    """TLS-connect to ip presenting Host: dom (SNI=dom) and return cert CN/SANs."""
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((ip, 443), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=dom) as ss:
                cert = ss.getpeercert()
                cn = dict(x[0] for x in cert.get("subject", ())).get("commonName")
                sans = [x[1] for x in cert.get("subjectAltName", ())]
                issuer = dict(x[0] for x in cert.get("issuer", ())).get("organizationName")
                return cn, sans, issuer
    except Exception as e:
        return None, None, str(e)


def fetch_with_host(ip, dom, timeout=8):
    """Plain HTTP to ip with Host: dom — many origins serve on 80."""
    try:
        s = socket.create_connection((ip, 80), timeout=timeout)
        s.sendall(("GET / HTTP/1.1\r\nHost: %s\r\nUser-Agent: Mozilla/5.0\r\n"
                   "Connection: close\r\n\r\n" % dom).encode())
        data = b""
        while len(data) < 20000:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        s.close()
        return data.decode("utf-8", "replace")
    except Exception as e:
        return None


def probe(ip, dom, cf_body):
    cn, sans, issuer = get_origin_cert_cn(ip, dom)
    http_body = fetch_with_host(ip, dom)
    signals = []
    if cn and dom.split(".")[0] in str(cn):
        signals.append("cert-cn=%s" % cn)
    if sans and any(dom in str(x) for x in sans):
        signals.append("cert-san-match")
    if issuer and "Let's Encrypt" in str(issuer):
        signals.append("LE-cert")
    if http_body:
        if "maintenance" in http_body.lower():
            signals.append("serves-maintenance")
        if dom in http_body:
            signals.append("body-mentions-domain")
        title = re.search(r"<title>([^<]*)</title>", http_body, re.I)
        if title:
            signals.append("title='%s'" % title.group(1)[:40])
    return signals


def main():
    if len(sys.argv) < 2:
        print(__doc__); return
    dom = sys.argv[1].strip().lower().replace("https://", "").replace("http://", "").split("/")[0]
    ips, rng = [], None
    args = sys.argv[2:]
    for i, a in enumerate(args):
        if a == "--ip" and i + 1 < len(args):
            ips.append(args[i + 1])
        if a == "--range" and i + 1 < len(args):
            rng = args[i + 1]
    if rng:
        net = ipaddress.ip_network(rng, strict=False)
        if net.num_addresses > 512:
            print("range too large (>512); narrow it"); return
        ips += [str(h) for h in net.hosts()]

    cf_status, cf_body = get_cf_front(dom)
    print("=" * 60)
    print("CF ORIGIN FINDER:", dom, "(front HTTP %s)" % cf_status)
    print("=" * 60)
    if not ips:
        print("no candidate IPs. pass --ip <ip> (repeatable) or --range <cidr>")
        print("tip: get candidates from crt.sh, historical DNS, or the ASN's range")
        return

    for ip in ips:
        sig = probe(ip, dom, cf_body)
        mark = "  <<< CANDIDATE" if sig else ""
        print("%-16s %s%s" % (ip, "; ".join(sig) if sig else "no signal", mark))

    print("\n[AUTO-HOST-HEADER] confirmed candidates: re-run with")
    print("   curl -H 'Host: %s' https://<ip>/   to view origin directly" % dom)
    print("=" * 60)


if __name__ == "__main__":
    main()

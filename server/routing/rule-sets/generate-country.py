#!/usr/bin/env python3
"""Build a reviewed CN geolocation candidate from a pinned DB-IP CSV download.

Maintainer-only: Python 3 standard library plus a local sing-box executable.
No network access, no edits to the live bundle, and no registration/ASN fallback.
"""
import argparse
import csv
import gzip
import hashlib
import io
import ipaddress
import json
import pathlib
import re
import shutil
import subprocess
import tempfile


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def collapse(networks):
    return [network for version in (4, 6)
            for network in ipaddress.collapse_addresses(n for n in networks if n.version == version)]


def intervals(networks, version):
    return [(int(n.network_address), int(n.broadcast_address)) for n in networks if n.version == version]


def subtract(left, right):
    result = []
    j = 0
    for start, end in left:
        while j < len(right) and right[j][1] < start:
            j += 1
        k, cursor = j, start
        while k < len(right) and right[k][0] <= end:
            other_start, other_end = right[k]
            if other_start > cursor:
                result.append((cursor, min(end, other_start - 1)))
            cursor = max(cursor, other_end + 1)
            if cursor > end:
                break
            k += 1
        if cursor <= end:
            result.append((cursor, end))
    return result


def describe_difference(before, after):
    result = {}
    for version in (4, 6):
        old, new = intervals(before, version), intervals(after, version)
        item = {}
        address = ipaddress.IPv4Address if version == 4 else ipaddress.IPv6Address
        for label, ranges in (("added", subtract(new, old)), ("removed", subtract(old, new))):
            cidrs = [str(cidr) for start, end in ranges
                     for cidr in ipaddress.summarize_address_range(address(start), address(end))]
            item[label] = {"cidrCount": len(cidrs), "addressCount": str(sum(z - a + 1 for a, z in ranges)), "cidrs": cidrs}
        result[f"ipv{version}"] = item
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_manifest", type=pathlib.Path)
    parser.add_argument("source_csv_gz", type=pathlib.Path)
    parser.add_argument("output_directory", type=pathlib.Path)
    parser.add_argument("--baseline", type=pathlib.Path, default=pathlib.Path(__file__).with_name("geoip-cn.json"))
    parser.add_argument("--sing-box", default="sing-box")
    args = parser.parse_args()
    source = json.loads(args.source_manifest.read_text())
    if (source.get("format") != "dbip-country-lite-csv-gzip"
            or source.get("selection") != "country=CN"
            or not re.fullmatch(r"https://download\.db-ip\.com/free/dbip-country-lite-\d{4}-\d{2}\.csv\.gz", source.get("url", ""))
            or not re.fullmatch(r"[a-f0-9]{64}", source.get("sha256", ""))):
        raise ValueError("Unsupported or unpinned country source")
    if args.output_directory.exists():
        raise ValueError("Output must be a new directory; existing baseline is never overwritten")
    if args.source_csv_gz.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Compressed country source is too large")
    payload = args.source_csv_gz.read_bytes()
    if len(payload) != source["bytes"] or digest(payload) != source["sha256"]:
        raise ValueError("Approved source checksum or length mismatch")
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
        decoded = stream.read(64 * 1024 * 1024 + 1)
    if len(decoded) > 64 * 1024 * 1024:
        raise ValueError("Uncompressed country source is too large")
    if (len(decoded) != source["uncompressedBytes"]
            or digest(decoded) != source["uncompressedSha256"]
            or hashlib.sha1(decoded).hexdigest() != source["upstreamSha1"]):
        raise ValueError("Uncompressed source does not match reviewed publication")
    networks, row_count, cn_rows, previous = [], 0, 0, {4: -1, 6: -1}
    for row in csv.reader(io.StringIO(decoded.decode("utf-8"))):
        row_count += 1
        if len(row) != 3 or not re.fullmatch(r"[A-Z]{2}", row[2]):
            raise ValueError(f"Invalid country CSV row {row_count}")
        start, end = map(ipaddress.ip_address, row[:2])
        if start.version != end.version or start > end or int(start) <= previous[start.version]:
            raise ValueError(f"Unsorted or overlapping country range at row {row_count}")
        previous[start.version] = int(end)
        if row[2] == "CN":
            cn_rows += 1
            networks.extend(ipaddress.summarize_address_range(start, end))
    if row_count != source["records"] or not cn_rows:
        raise ValueError("Incomplete country source")
    networks = collapse(networks)
    for case in source["validationCases"]:
        address = ipaddress.ip_address(case["ip"])
        matched = any(address in network for network in networks if network.version == address.version)
        if matched != case["domestic"]:
            raise ValueError(f"Country regression failed: {address}")
    baseline_bytes = args.baseline.read_bytes()
    baseline = json.loads(baseline_bytes)
    old_networks = collapse([ipaddress.ip_network(cidr) for rule in baseline["rules"] for cidr in rule["ip_cidr"]])
    args.output_directory.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(prefix=".country-candidate-", dir=args.output_directory.parent))
    try:
        raw_path, binary_path = staging / "input.json", staging / "geoip-cn.srs"
        raw_path.write_text(json.dumps({"version": 3, "rules": [{"ip_cidr": list(map(str, networks))}]}, separators=(",", ":")) + "\n")
        subprocess.run([args.sing_box, "rule-set", "compile", str(raw_path), "-o", str(binary_path)], check=True, timeout=30)
        json_path = staging / "geoip-cn.json"
        subprocess.run([args.sing_box, "rule-set", "decompile", str(binary_path), "-o", str(json_path)], check=True, timeout=30)
        compiled_json = json.loads(json_path.read_text())
        # The published JSON is the native canonical decompilation, matching
        # existing inline-export and binary cache semantics exactly.
        json_path.write_text(json.dumps(compiled_json, separators=(",", ":")) + "\n")
        rebuild = staging / "roundtrip.srs"
        subprocess.run([args.sing_box, "rule-set", "compile", str(json_path), "-o", str(rebuild)], check=True, timeout=30)
        if rebuild.read_bytes() != binary_path.read_bytes():
            raise ValueError("Native inline/binary roundtrip differs")
        raw_path.unlink()
        rebuild.unlink()
        binary_bytes, json_bytes = binary_path.read_bytes(), json_path.read_bytes()
        report = {
            "source": source,
            "generator": "generate-country.py/v1",
            "compiler": subprocess.check_output([args.sing_box, "version"], text=True).splitlines()[0],
            "baselineSha256": digest(baseline_bytes),
            "sourceRecords": row_count, "selectedRecords": cn_rows,
            "before": {"cidrCount": len(old_networks)},
            "after": {"cidrCount": len(networks), "ipv4CidrCount": sum(n.version == 4 for n in networks), "ipv6CidrCount": sum(n.version == 6 for n in networks)},
            "difference": describe_difference(old_networks, networks),
            "artifact": {"filename": "geoip-cn.srs", "delivery": "bundled", "sha256": digest(binary_bytes), "bytes": len(binary_bytes), "jsonFilename": "geoip-cn.json", "jsonSha256": digest(json_bytes), "statistics": {"ip_cidr": len(networks)}, "source": source}
        }
        (staging / "country-review.json").write_text(json.dumps(report, indent=2) + "\n")
        staging.rename(args.output_directory)
        print(json.dumps({"output": str(args.output_directory), "before": report["before"], "after": report["after"], "artifactSha256": report["artifact"]["sha256"]}))
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == "__main__":
    main()

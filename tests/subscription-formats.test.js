import assert from "node:assert/strict";
import test from "node:test";

import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";
import { buildMultiHostProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";

test("full smart profiles expose a manual unclassified group after all domain and IP rules", () => {
  for (const format of ["mihomo", "mihomo-modern", "egern-profile"]) {
    const body = buildSubscriptionArtifact({ format, singBoxConfig }).body;
    const unknown = body.split('name: "未分类流量"')[1]?.split(/\n  - |\nrules:|\nrule-providers:/)[0];
    assert.ok(unknown, `${format} must declare the manual fallback`);
    assert.match(unknown, /(?:proxies|policies):\n\s+- "RayLink 代理"\n\s+- "DIRECT"/);
    const rules = body.split("\nrules:\n")[1].trim();
    assert.ok(rules.endsWith(format === "egern-profile" ? 'policy: "未分类流量"' : '"MATCH,未分类流量"'));
    for (const [mode, expected] of [["global-proxy", "RayLink 代理"], ["direct", "DIRECT"]]) {
      const other = buildSubscriptionArtifact({ format, singBoxConfig, routePolicy: { mode } }).body;
      assert.ok(!other.includes('name: "未分类流量"'));
      const otherRules = other.split("\nrules:\n")[1].trim();
      assert.ok(otherRules.endsWith(format === "egern-profile" ? `policy: "${expected}"` : `"MATCH,${expected}"`));
    }
  }
});

test("full exports preserve exact AI dependency matching and custom DNS overrides", () => {
  for (const format of ["mihomo", "mihomo-modern"]) {
    const body = buildSubscriptionArtifact({ format, singBoxConfig, routePolicy: { rules: [
      { match: "domain", value: "cdn.workos.com", action: "direct" },
      { match: "domain_suffix", value: "imgix.net", action: "proxy" }
    ] } }).body;
    const dns = body.split("  nameserver-policy:\n")[1].split("  proxy-server-nameserver:")[0];
    assert.match(dns, /"\+\.challenges\.cloudflare\.com":\n\s+- "https:\/\/1\.1\.1\.1\/dns-query#AI 网站代理"/);
    assert.match(dns, /"cdn\.workos\.com":\n\s+- "https:\/\/223\.5\.5\.5\/dns-query"/);
    assert.doesNotMatch(dns, /"domain:/);
    assert.doesNotMatch(dns, /"workos\.imgix\.net":/);
    const routes = body.split("\nrules:\n")[1];
    assert.ok(routes.includes('"DOMAIN-SUFFIX,challenges.cloudflare.com,AI 网站代理"'));
    assert.ok(routes.includes('"DOMAIN-SUFFIX,claude.com,AI 网站代理"'));
    for (const host of ["aistudio.google.com", "notebooklm.google.com", "copilot.microsoft.com", "copilot.cloud.microsoft", "copilot-proxy.githubusercontent.com", "origin-tracker.githubusercontent.com"]) {
      assert.ok(routes.includes(`"DOMAIN,${host},AI 网站代理"`));
      assert.ok(dns.includes(`"${host}":\n      - "https://1.1.1.1/dns-query#AI 网站代理"`));
    }
    const custom = routes.indexOf('DOMAIN,cdn.workos.com,DIRECT');
    assert.ok(custom >= 0 && custom < routes.indexOf('DOMAIN,cdn.workos.com,AI 网站代理'));
    for (const domain of ["cloudflare.com", "workos.com", "workoscdn.com", "imgix.net"]) assert.ok(!routes.includes(`DOMAIN-SUFFIX,${domain},AI 网站代理`));
  }
  const egern = buildSubscriptionArtifact({ format: "egern-profile", singBoxConfig, routePolicy: { rules: [
    { match: "domain", value: "cdn.workos.com", action: "direct" }
  ] } }).body;
  const forward = egern.split("  forward:\n")[1].split("  proxy_nameservers:")[0];
  const routes = egern.split("\nrules:\n")[1];
  assert.match(forward, /domain_suffix:\n\s+match: "challenges\.cloudflare\.com"\n\s+value: "ai"/);
  assert.match(routes, /domain_suffix:\n\s+match: "challenges\.cloudflare\.com"\n\s+policy: "AI 网站代理"/);
  assert.match(routes, /domain_suffix:\n\s+match: "claudeusercontent\.com"\n\s+policy: "AI 网站代理"/);
  for (const host of ["aistudio.google.com", "copilot.microsoft.com", "copilot.cloud.microsoft"]) {
    assert.ok(forward.includes(`domain:\n        match: "${host}"\n        value: "ai"`));
    assert.ok(routes.includes(`domain:\n      match: "${host}"\n      policy: "AI 网站代理"`));
  }
  const customDns = forward.indexOf('match: "cdn.workos.com"\n        value: "domestic"');
  const customRoute = routes.indexOf('match: "cdn.workos.com"\n      policy: "DIRECT"');
  assert.ok(customDns >= 0 && customDns < forward.indexOf('match: "cdn.workos.com"\n        value: "ai"'));
  assert.ok(customRoute >= 0 && customRoute < routes.indexOf('match: "cdn.workos.com"\n      policy: "AI 网站代理"'));
});

test("Egern preserves manual default selection, system DNS and domestic domain routing", () => {
  const body = buildSubscriptionArtifact({
    format: "egern-profile", singBoxConfig,
    routePolicy: { rules: [{ match: "domain", value: "office.example", action: "direct", dns: "system" }] }
  }).body;
  assert.match(body, /close_connections_on_policy_change: false/);
  assert.match(body, /match: "office\.example"\n\s+value: "local"/);
  const rules = body.split("\nrules:\n")[1];
  assert.match(rules, /match: "baidu\.com"\n\s+policy: "DIRECT"/);
  assert.match(rules, /default:\n\s+policy: "未分类流量"/);
});

test("AI subscriptions choose an independent stable exit and expose concrete node choices", () => {
  for (const format of ["mihomo", "egern-profile"]) {
    const body = buildSubscriptionArtifact({ format, singBoxConfig }).body;
    const aiSection = body.split('name: "AI 网站代理"')[1].split(/\n  - /)[0];
    assert.match(aiSection, /(?:proxies|policies):\n\s+- "AI 稳定出口"/);
    assert.match(aiSection, /- "raylink-tokyo-vless"/);
    assert.match(body, /name: "AI 稳定出口"/);
    const stableSection = body.split('name: "AI 稳定出口"')[1].split(/\n  - /)[0];
    assert.match(stableSection, /raylink-tokyo-vless/);
    assert.match(stableSection, /raylink-tokyo-hysteria2/);
    assert.ok(stableSection.indexOf("raylink-tokyo-vless") < stableSection.indexOf("raylink-tokyo-hysteria2"), "AI fallback prefers TCP before UDP");
  }
  const mihomo = buildSubscriptionArtifact({ format: "mihomo", singBoxConfig }).body;
  assert.match(mihomo, /store-selected: true/);
  assert.match(mihomo, /"\+\.openai\.com":\n\s+- "https:\/\/1\.1\.1\.1\/dns-query#AI 网站代理"/);
});

test("manual AI exports exclude automatic groups and unauthorized Host candidates", () => {
  const profiles = defaultProtocolConfigs().filter((profile) => ["vless", "hysteria2"].includes(profile.type))
    .map((profile) => ({ ...profile, enabled: true }));
  for (const hostId of ["primary", "no-longer-authorized"]) {
    const routePolicy = { aiSelection: "manual", aiExit: { mode: "pinned", hostId } };
    const nativeConfig = buildMultiHostProtocolClientConfig({
      credential: { email: "test@example.com", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "fixture", serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
      hosts: ["primary", "other-region"].map((id) => ({ id, address: `${id}.example.com`, protocols: profiles })),
      routePolicy
    });
    for (const format of ["mihomo", "mihomo-modern", "egern-profile"]) {
      const body = buildSubscriptionArtifact({ format, singBoxConfig: nativeConfig, routePolicy }).body;
      const ai = body.split('name: "AI 网站代理"')[1].split(/\n  - |\nrules:|\nrule-providers:/)[0];
      assert.doesNotMatch(ai, /AI 稳定出口|AI 节点选择|RayLink 智能|TCP 稳定|UDP 高速|故障回退|网络环境|RayLink 代理/);
      assert.doesNotMatch(ai, /raylink-other-region/);
      if (hostId === "no-longer-authorized") {
        assert.match(ai, /- "REJECT"/);
        assert.doesNotMatch(ai, /use:|filter:|raylink-primary/);
      } else if (format === "mihomo-modern") {
        assert.match(ai, /use:\n\s+- "raylink-health"/);
        const patterns = JSON.parse(ai.match(/filter: (.+)/)[1]).split("`").map((pattern) => new RegExp(pattern));
        assert.deepEqual(patterns.map((pattern) => ["raylink-primary-vless", "raylink-primary-hysteria2"].find((name) => pattern.test(name))),
          ["raylink-primary-vless", "raylink-primary-hysteria2"]);
        for (const name of ["raylink-other-region-vless", "raylink-other-region-hysteria2", "raylink-primary-vless-extra"]) {
          assert.ok(!patterns.some((pattern) => pattern.test(name)), `Provider must not introduce ${name} into AI selection`);
        }
      } else {
        assert.match(ai, /(?:proxies|policies):\n\s+- "raylink-primary-vless"\n\s+- "raylink-primary-hysteria2"/);
      }
    }
  }
});

test("Egern AI DNS follows its exit while explicit user IP rules retain priority", () => {
  const body = buildSubscriptionArtifact({
    format: "egern-profile", singBoxConfig,
    routePolicy: { rules: [{ match: "ip", value: "9.9.9.9", action: "direct" }] }
  }).body;
  assert.match(body, /ai:\n\s+- "https:\/\/9\.9\.9\.9\/dns-query"/);
  assert.match(body, /match: "openai\.com"\n\s+value: "ai"/);
  const rules = body.split("\nrules:\n")[1];
  const reserved = rules.indexOf('match: "9.9.9.9/32"\n      policy: "AI 网站代理"');
  const custom = rules.indexOf('match: "9.9.9.9/32"\n      policy: "DIRECT"');
  assert.ok(custom >= 0 && reserved > custom);
  const direct = buildSubscriptionArtifact({ format: "egern-profile", singBoxConfig, routePolicy: { mode: "direct" } }).body;
  assert.doesNotMatch(direct, /9\.9\.9\.9/);
});

test("Egern uses literal private IP bypass first and resolving IPv4/IPv6 rules after domain decisions", () => {
  const body = buildSubscriptionArtifact({ format: "egern-profile", singBoxConfig, routePolicy: { rules: [
    { match: "domain", value: "corp.example", action: "proxy", priority: 1 },
    { match: "ip_cidr", value: "2001:db8::/32", action: "block", priority: 2 }
  ] } }).body;
  const rules = body.split("\nrules:\n")[1];
  assert.match(rules, /ip_cidr:\n\s+match: "10\.0\.0\.0\/8"\n\s+policy: "DIRECT"\n\s+no_resolve: true/);
  assert.match(rules, /ip_cidr6:\n\s+match: "2001:db8::\/32"\n\s+policy: "REJECT"/);
  assert.ok(rules.lastIndexOf('match: "10.0.0.0/8"') > rules.indexOf('match: "corp.example"'));
});

test("full client profiles carry the same offline China exact, suffix, regex and IP baseline", () => {
  const egern = buildSubscriptionArtifact({ format: "egern-profile", singBoxConfig }).body;
  assert.match(egern, /^# 智能分流内置规则版本: cn-[a-f0-9]+-[a-f0-9]+/);
  const forward = egern.split("  forward:\n")[1].split("  proxy_nameservers:")[0];
  const rules = egern.split("\nrules:\n")[1];
  for (const part of [forward, rules]) {
    assert.match(part, /domain:\n\s+match: "a1\.mzstatic\.com"/);
    assert.ok(part.includes(JSON.stringify("^.+\\.alibaba$")), "leading-dot suffix must exclude apex");
    assert.ok(part.includes(JSON.stringify("^nis.+\\.10010\\.com$")));
  }
  assert.match(rules, /ip_cidr:\n\s+match: "1\.0\.1\.0\/24"/);
  const mihomo = buildSubscriptionArtifact({ format: "mihomo", singBoxConfig }).body;
  assert.match(mihomo, /rule-providers:/);
  assert.match(mihomo, /"rule-set:raylink-cn-domain":/);
  assert.ok(mihomo.includes('"DOMAIN,a1.mzstatic.com"'));
  assert.ok(mihomo.includes(JSON.stringify("DOMAIN-REGEX,^.+\\.alibaba$")));
  assert.ok(mihomo.includes(JSON.stringify("DOMAIN-REGEX,^nis.+\\.10010\\.com$")));
  assert.ok(mihomo.includes('"1.0.1.0/24"'));
  assert.match(mihomo, /RULE-SET,raylink-cn-domain,DIRECT/);
  assert.match(mihomo, /RULE-SET,raylink-cn-ip,DIRECT/);
  assert.doesNotMatch(mihomo, /GEOSITE,|GEOIP,|geosite:cn/);
});

test("explicit overseas services precede China GeoIP and keep matching remote DNS", () => {
  const mihomo = buildSubscriptionArtifact({ format: "mihomo", singBoxConfig }).body;
  assert.ok(mihomo.includes('DOMAIN-SUFFIX,google.com,RayLink 代理'));
  assert.ok(mihomo.indexOf('DOMAIN-SUFFIX,google.com,RayLink 代理') < mihomo.indexOf('RULE-SET,raylink-cn-ip,DIRECT'));
  assert.match(mihomo, /"\+\.google\.com":\n\s+- "https:\/\/1\.1\.1\.1\/dns-query#RayLink 代理"/);
  const egern = buildSubscriptionArtifact({ format: "egern-profile", singBoxConfig }).body;
  const rules = egern.split("\nrules:\n")[1];
  assert.match(rules, /match: "google\.com"\n\s+policy: "RayLink 代理"/);
  assert.ok(rules.indexOf('match: "google.com"') < rules.indexOf('match: "1.0.1.0/24"'));
  assert.match(egern, /match: "google\.com"\n\s+value: "overseas"/);
});

test("Mihomo DNS protects local names and respects a higher priority broader domain rule", () => {
  const body = buildSubscriptionArtifact({
    format: "mihomo", singBoxConfig,
    routePolicy: { rules: [
      { match: "domain", value: "nas.home.arpa", action: "proxy", priority: 1 },
      { match: "domain_suffix", value: "google.com", action: "direct", priority: 2 },
      { match: "domain", value: "mail.google.com", action: "proxy", priority: 3 }
    ] }
  }).body;
  const policy = body.split('  nameserver-policy:\n')[1].split('  proxy-server-nameserver:')[0];
  assert.doesNotMatch(policy, /"nas\.home\.arpa"/);
  assert.doesNotMatch(policy, /"mail\.google\.com"/);
  assert.doesNotMatch(policy, /"\+\.gemini\.google\.com"/);
  assert.match(policy, /"\+\.google\.com":\n\s+- "https:\/\/223\.5\.5\.5\/dns-query"/);
});

test("Mihomo preserves endpoint pins while excluding local discovery names from fake IP", () => {
  for (const format of ["mihomo", "mihomo-modern"]) {
    for (const endpointOverrides of [{}, { "node.example.com": "203.0.113.20" }]) {
      const body = buildSubscriptionArtifact({ format, singBoxConfig, endpointOverrides }).body;
      const filter = body.split("  fake-ip-filter:\n")[1]?.split("  respect-rules:")[0];
      assert.ok(filter, `${format} must exclude local discovery names even without endpoint pins`);
      const names = [...filter.matchAll(/- "([^"]+)"/g)].map((match) => match[1]);
      assert.deepEqual(names, [...Object.keys(endpointOverrides), "localhost", "+.local", "+.lan", "+.home.arpa"]);
      assert.equal(new Set(names).size, names.length);
    }
  }
});

test("TCP-only Shadowsocks never advertises UDP relay in exported subscriptions", () => {
  const config = { outbounds: [{
    type: "shadowsocks", tag: "ss-tcp", server: "node.example.com", server_port: 8388,
    method: "2022-blake3-aes-128-gcm", password: "AAAAAAAAAAAAAAAAAAAAAA==", network: "tcp"
  }] };
  const exportBody = (format) => buildSubscriptionArtifact({ format, singBoxConfig: config }).body;
  assert.match(exportBody("mihomo"), /udp: false/);
  assert.match(exportBody("egern"), /udp_relay: false/);
  assert.match(exportBody("loon"), /udp=false/);
});

test("Egern custom proxy rules reference a declared policy", () => {
  const body = buildSubscriptionArtifact({
    format: "egern-profile", singBoxConfig,
    routePolicy: { rules: [{ match: "domain", value: "example.com", action: "proxy" }] }
  }).body;
  const names = new Set([...body.matchAll(/^\s+name: "([^"]+)"$/gm)].map((match) => match[1]));
  for (const [, policy] of body.matchAll(/^\s+(?:policy|default_policy): "([^"]+)"$/gm)) {
    assert.ok(["DIRECT", "REJECT"].includes(policy) || names.has(policy), `undefined policy: ${policy}`);
  }
});

test("Mihomo duplicate domain DNS rules honor the first routing rule", () => {
  const body = buildSubscriptionArtifact({
    format: "mihomo", singBoxConfig,
    routePolicy: { rules: [
      { match: "domain", value: "example.com", action: "direct", priority: 10 },
      { match: "domain", value: "example.com", action: "proxy", priority: 20 }
    ] }
  }).body;
  assert.match(body, /"example.com":\n\s+- "https:\/\/223\.5\.5\.5\/dns-query"/);
});

test("Mihomo local IP bypass does not resolve domains before domain routing", () => {
  const body = buildSubscriptionArtifact({ format: "mihomo", singBoxConfig }).body;
  assert.match(body, /"IP-CIDR,10\.0\.0\.0\/8,DIRECT,no-resolve"/);
  assert.doesNotMatch(body, /DOMAIN-SUFFIX,(google|youtube)\.com,RayLink 智能/);
});

test("Mihomo resolves split-DNS private hosts after domain decisions in every mode", () => {
  for (const mode of ["smart", "global-proxy", "direct"]) {
    const body = buildSubscriptionArtifact({
      format: "mihomo", singBoxConfig,
      routePolicy: { mode, rules: [{ match: "domain", value: "corp.example", action: "proxy" }] }
    }).body;
    const rules = body.split("\nrules:\n")[1].trim().split("\n").map((line) => JSON.parse(line.trim().slice(2)));
    const privateRule = rules.indexOf("IP-CIDR,10.0.0.0/8,DIRECT");
    assert.ok(privateRule > rules.indexOf("DOMAIN,corp.example,RayLink 代理"));
    assert.ok(privateRule < rules.findIndex((rule) => rule.startsWith("MATCH,")));
    if (mode === "smart") {
      assert.ok(privateRule > rules.indexOf("RULE-SET,raylink-cn-domain,DIRECT"));
      assert.ok(privateRule < rules.indexOf("RULE-SET,raylink-cn-ip,DIRECT"));
    }
  }
});

const singBoxConfig = {
  outbounds: [
    {
      type: "vless",
      tag: "raylink-tokyo-vless",
      server: "node.example.com",
      server_port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      tls: {
        enabled: true,
        server_name: "www.microsoft.com",
        reality: {
          enabled: true,
          public_key: "public-key",
          short_id: "a1b2c3d4"
        }
      }
    },
    {
      type: "hysteria2",
      tag: "raylink-tokyo-hysteria2",
      server: "node.example.com",
      server_port: 8448,
      password: "hysteria-password",
      tls: {
        enabled: true,
        server_name: "node.example.com"
      }
    },
    {
      type: "urltest",
      tag: "raylink-smart",
      outbounds: ["raylink-tokyo-vless"]
    },
    {
      type: "urltest",
      tag: "raylink-tcp",
      outbounds: ["raylink-tokyo-vless"]
    },
    {
      type: "urltest",
      tag: "raylink-udp",
      outbounds: ["raylink-tokyo-hysteria2"]
    },
    {
      type: "selector",
      tag: "raylink-auto",
      outbounds: ["raylink-smart", "raylink-tcp", "raylink-udp"]
    },
    { type: "direct", tag: "direct" }
  ]
};

test("smart endpoint overrides adapt dialing without replacing the Host identity", () => {
  const endpointOverrides = {
    "node.example.com": "203.0.113.20"
  };

  const singBox = JSON.parse(buildSubscriptionArtifact({
    format: "singbox",
    singBoxConfig,
    endpointOverrides
  }).body);
  const vless = singBox.outbounds.find((outbound) => outbound.type === "vless");
  assert.equal(vless.server, "node.example.com");
  assert.equal(vless.domain_resolver, "raylink-endpoint-hosts");
  assert.deepEqual(
    singBox.dns.servers.find((server) => server.tag === "raylink-endpoint-hosts"),
    {
      type: "hosts",
      tag: "raylink-endpoint-hosts",
      predefined: { "node.example.com": "203.0.113.20" }
    }
  );

  const loon = buildSubscriptionArtifact({
    format: "loon",
    singBoxConfig,
    endpointOverrides
  }).body;
  assert.match(loon, /raylink-tokyo-hysteria2=Hysteria2,203\.0\.113\.20,8448,/);
  assert.match(loon, /sni=node\.example\.com/);
  assert.doesNotMatch(loon, /tls-name=/);
  assert.doesNotMatch(loon, /=Hysteria2,node\.example\.com,8448,/);

  const implicitTlsNameConfig = {
    outbounds: [{
      type: "hysteria2",
      tag: "raylink-implicit-sni",
      server: "node.example.com",
      server_port: 8448,
      password: "hysteria-password",
      tls: { enabled: true }
    }]
  };
  const implicitLoon = buildSubscriptionArtifact({
    format: "loon",
    singBoxConfig: implicitTlsNameConfig,
    endpointOverrides
  }).body;
  assert.match(implicitLoon, /Hysteria2,203\.0\.113\.20,8448,[^\n]+sni=node\.example\.com/);
  const implicitEgern = buildSubscriptionArtifact({
    format: "egern",
    singBoxConfig: implicitTlsNameConfig,
    endpointOverrides
  }).body;
  assert.match(implicitEgern, /server: "203\.0\.113\.20"/);
  assert.match(implicitEgern, /sni: "node\.example\.com"/);
});

test("Mihomo subscription contains compatible nodes, smart groups, routing and DNS", () => {
  const artifact = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig
  });

  assert.equal(artifact.contentType, "application/yaml; charset=utf-8");
  assert.equal(artifact.filename, "raylink-mihomo.yaml");
  assert.match(artifact.body, /^mixed-port: 7890/m);
  assert.match(artifact.body, /type: "vless"/);
  assert.match(artifact.body, /reality-opts:/);
  assert.match(artifact.body, /name: "RayLink 智能"/);
  assert.match(artifact.body, /name: "TCP 稳定"/);
  assert.match(artifact.body, /name: "UDP 高速"/);
  assert.match(artifact.body, /name: "AI 网站代理"/);
  assert.match(artifact.body, /lazy: false/);
  assert.match(artifact.body, /max-failed-times: 3/);
  assert.match(artifact.body, /expected-status: 204/);
  assert.match(
    artifact.body,
    /name: "RayLink 智能"[\s\S]*?timeout: 12000[\s\S]*?name: "TCP 稳定"[\s\S]*?timeout: 12000[\s\S]*?name: "UDP 高速"[\s\S]*?timeout: 12000[\s\S]*?name: "故障回退"[\s\S]*?timeout: 12000/
  );
  assert.match(
    artifact.body,
    /name: "故障回退"[\s\S]*?proxies:[\s\S]*?- "raylink-tokyo-vless"[\s\S]*?- "raylink-tokyo-hysteria2"/
  );
  assert.match(
    artifact.body,
    /name: "AI 网站代理"[\s\S]*?proxies:[\s\S]*?- "故障回退"/
  );
  assert.match(artifact.body, /store-selected: true/);
  assert.match(
    artifact.body,
    /name: "手动选择"[\s\S]*?proxies:[\s\S]*?- "raylink-tokyo-vless"[\s\S]*?- "raylink-tokyo-hysteria2"/
  );
  assert.match(artifact.body, /DOMAIN-SUFFIX,openai\.com,AI 网站代理/);
  assert.match(artifact.body, /DOMAIN-SUFFIX,chatgpt\.com,AI 网站代理/);
  assert.match(artifact.body, /RULE-SET,raylink-cn-ip,DIRECT/);
  assert.doesNotMatch(artifact.body, /RULE-SET,raylink-cn-ip,DIRECT,no-resolve/);
  assert.match(artifact.body, /MATCH,未分类流量/);
  assert.match(artifact.body, /DOMAIN-SUFFIX,local,DIRECT/);
  assert.match(artifact.body, /IP-CIDR,192\.168\.0\.0\/16,DIRECT/);
  assert.match(artifact.body, /IP-CIDR6,fc00::\/7,DIRECT/);
  assert.match(artifact.body, /nameserver-policy:/);
  assert.match(
    artifact.body,
    /"rule-set:raylink-cn-domain":[\s\S]*?- "https:\/\/223\.5\.5\.5\/dns-query"/
  );
  assert.match(
    artifact.body,
    /nameserver:[\s\S]*?- "https:\/\/1\.1\.1\.1\/dns-query#RayLink 代理"/
  );
});

test("modern Mihomo shares health checks while legacy exports retain standalone nodes", () => {
  const legacy = buildSubscriptionArtifact({ format: "mihomo", singBoxConfig });
  const modern = buildSubscriptionArtifact({ format: "mihomo-modern", singBoxConfig });
  assert.equal(legacy.filename, "raylink-mihomo.yaml");
  assert.match(legacy.body, /^proxies:\n/m);
  assert.doesNotMatch(legacy.body, /^proxy-providers:/m);
  assert.equal(modern.filename, "raylink-mihomo-modern.yaml");
  assert.match(modern.body, /^# .*Mihomo >= 1\.19\.1.*format=mihomo/);
  assert.match(modern.body, /^proxy-providers:\n  raylink-health:\n    type: "inline"/m);
  assert.doesNotMatch(modern.body, /^proxies:/m);
  assert.equal((modern.body.match(/health-check:/g) || []).length, 1);
  assert.match(modern.body, /health-check:\n      enable: true[\s\S]*?timeout: 12000/);
  const group = (body, name) => body.split(`name: "${name}"`)[1].split(/\n  - |\nrule-providers:/)[0];
  for (const name of ["RayLink 代理", "AI 网站代理", "RayLink 智能", "TCP 稳定", "UDP 高速", "故障回退", "AI 稳定出口", "手动选择"]) {
    assert.match(modern.body, new RegExp(`name: "${name}"`));
    assert.equal(group(modern.body, name).match(/type: "([^"\n]+)"/)[1], group(legacy.body, name).match(/type: "([^"\n]+)"/)[1]);
  }
  for (const body of [legacy.body, modern.body]) {
    for (const name of ["RayLink 智能", "TCP 稳定", "UDP 高速", "故障回退", "AI 稳定出口"]) assert.match(group(body, name), /timeout: 12000/);
  }
  const ai = group(modern.body, "AI 网站代理");
  assert.match(ai, /proxies:\n\s+- "AI 稳定出口"/);
  const filter = (name) => JSON.parse(group(modern.body, name).match(/filter: (.+)/)[1]).split("`").map((pattern) => new RegExp(pattern));
  assert.ok(filter("TCP 稳定").some((pattern) => pattern.test("raylink-tokyo-vless")));
  assert.ok(!filter("TCP 稳定").some((pattern) => pattern.test("raylink-tokyo-hysteria2")));
  assert.ok(filter("UDP 高速").some((pattern) => pattern.test("raylink-tokyo-hysteria2")));
  assert.ok(filter("AI 稳定出口").some((pattern) => pattern.test("raylink-tokyo-hysteria2")));
  assert.deepEqual(filter("故障回退").map((pattern) => ["raylink-tokyo-vless", "raylink-tokyo-hysteria2"].find((name) => pattern.test(name))), ["raylink-tokyo-vless", "raylink-tokyo-hysteria2"]);
  assert.equal(modern.body.split("\nrules:\n")[1], legacy.body.split("\nrules:\n")[1]);
});

test("modern Mihomo filters treat node names as exact literals, including its filter delimiter", () => {
  const name = "node.[one](a)|alt`second";
  const config = { outbounds: [{ type: "shadowsocks", tag: name, server: "node.example.com", server_port: 8388, method: "aes-128-gcm", password: "fixture" }] };
  const body = buildSubscriptionArtifact({ format: "mihomo-modern", singBoxConfig: config }).body;
  const group = body.split('name: "手动选择"')[1].split(/\nrule-providers:/)[0];
  const filter = JSON.parse(group.match(/filter: (.+)/)[1]);
  assert.equal(filter.split("`").length, 1, "A literal backtick must not create a second filter");
  const pattern = new RegExp(filter);
  assert.ok(pattern.test(name));
  assert.ok(!pattern.test("alt"));
  assert.ok(!pattern.test(name + "-other"));
});

test("Mihomo DNS policies use valid suffix patterns for local and custom domains", () => {
  const artifact = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig,
    routePolicy: {
      mode: "smart",
      rules: [
        {
          id: "direct-work",
          match: "domain_suffix",
          value: "work.example",
          action: "direct",
          dns: "domestic",
          priority: 10,
          enabled: true
        },
        {
          id: "direct-tracker",
          match: "domain",
          value: "tracker.example",
          action: "direct",
          dns: "system",
          priority: 20,
          enabled: true
        }
      ]
    }
  });

  for (const suffix of ["local", "lan", "home.arpa", "work.example"]) {
    assert.match(artifact.body, new RegExp(`"\\+\\.${suffix.replaceAll(".", "\\.")}":`));
  }
  assert.match(artifact.body, /\n    localhost:/);
  assert.match(artifact.body, /"tracker\.example":/);
  assert.doesNotMatch(artifact.body, /"\+\.tracker\.example":/);
  assert.doesNotMatch(artifact.body, /"domain:\*\./);
});

test("all full subscription formats compile the same custom routing policy", () => {
  const routePolicy = {
    mode: "smart",
    rules: [
      {
        id: "direct-work",
        match: "domain_suffix",
        value: "work.example",
        action: "direct",
        dns: "domestic",
        priority: 10,
        enabled: true
      },
      {
        id: "block-tracker",
        match: "domain",
        value: "tracker.example",
        action: "block",
        dns: "auto",
        priority: 20,
        enabled: true
      }
    ]
  };
  const mihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig,
    routePolicy
  }).body;
  const egern = buildSubscriptionArtifact({
    format: "egern-profile",
    singBoxConfig,
    routePolicy
  }).body;

  assert.match(mihomo, /DOMAIN-SUFFIX,work\.example,DIRECT/);
  assert.match(mihomo, /DOMAIN,tracker\.example,REJECT/);
  assert.match(mihomo, /"\+\.work\.example":[\s\S]*223\.5\.5\.5/);
  assert.match(egern, /match: "work\.example"[\s\S]*policy: "DIRECT"/);
  assert.match(egern, /match: "tracker\.example"[\s\S]*policy: "REJECT"/);
  assert.match(egern, /no_resolve: true/);
});

test("global and direct modes keep DNS behavior aligned across client formats", () => {
  const globalMihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig,
    routePolicy: { mode: "global-proxy" }
  }).body;
  const globalEgern = buildSubscriptionArtifact({
    format: "egern-profile",
    singBoxConfig,
    routePolicy: { mode: "global-proxy" }
  }).body;
  const directMihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig,
    routePolicy: { mode: "direct" }
  }).body;
  const directEgern = buildSubscriptionArtifact({
    format: "egern-profile",
    singBoxConfig,
    routePolicy: { mode: "direct" }
  }).body;

  assert.doesNotMatch(globalMihomo, /"rule-set:raylink-cn-domain":/);
  assert.match(globalMihomo, /MATCH,RayLink 代理/);
  assert.match(globalEgern, /match: "\*"[\s\S]*?value: "overseas"/);
  assert.match(directMihomo, /nameserver:[\s\S]*?223\.5\.5\.5/);
  assert.doesNotMatch(directMihomo, /1\.1\.1\.1\/dns-query#RayLink 代理/);
  assert.match(directEgern, /match: "\*"[\s\S]*?value: "domestic"/);
});

test("Egern node subscription uses its native proxy schema and excludes unsupported protocols", () => {
  const artifact = buildSubscriptionArtifact({
    format: "egern",
    singBoxConfig: {
      ...singBoxConfig,
      outbounds: [
        {
          type: "naive",
          tag: "raylink-tokyo-naive",
          server: "node.example.com",
          server_port: 7443,
          username: "user@example.com",
          password: "password",
          tls: { enabled: true, server_name: "node.example.com" }
        },
        ...singBoxConfig.outbounds
      ]
    }
  });

  assert.equal(artifact.contentType, "application/yaml; charset=utf-8");
  assert.equal(artifact.filename, "raylink-egern.yaml");
  assert.match(artifact.body, /^proxies:/m);
  assert.match(artifact.body, /- vless:/);
  assert.match(artifact.body, /user_id: "11111111-1111-4111-8111-111111111111"/);
  assert.match(artifact.body, /reality:/);
  assert.match(artifact.body, /- hysteria2:/);
  assert.doesNotMatch(artifact.body, /naive/);
  assert.doesNotMatch(artifact.body, /policy_groups:/);
});

test("Loon node subscription uses native proxy lines and excludes unsupported protocols", () => {
  const artifact = buildSubscriptionArtifact({
    format: "loon",
    singBoxConfig: {
      ...singBoxConfig,
      outbounds: [
        ...singBoxConfig.outbounds,
        {
          type: "tuic",
          tag: "raylink-tokyo-tuic",
          server: "node.example.com",
          server_port: 8447,
          uuid: "22222222-2222-4222-8222-222222222222",
          password: "tuic-password",
          tls: { enabled: true, server_name: "node.example.com" }
        },
        {
          type: "anytls",
          tag: "raylink-invalid-anytls-ws",
          server: "node.example.com",
          server_port: 8445,
          password: "anytls-password",
          transport: { type: "ws", path: "/anytls" },
          tls: { enabled: true, server_name: "node.example.com" }
        }
      ]
    }
  });

  assert.equal(artifact.contentType, "text/plain; charset=utf-8");
  assert.equal(artifact.filename, "raylink-loon.list");
  assert.match(
    artifact.body,
    /^raylink-tokyo-vless=vless,node\.example\.com,443,"11111111-1111-4111-8111-111111111111",udp=true,transport=tcp,over-tls=true,sni=www\.microsoft\.com,public-key="public-key",short-id=a1b2c3d4$/m
  );
  assert.match(
    artifact.body,
    /^raylink-tokyo-hysteria2=Hysteria2,node\.example\.com,8448,"hysteria-password",sni=node\.example\.com,skip-cert-verify=false,udp=true$/m
  );
  assert.doesNotMatch(artifact.body, /tls-name=/);
  assert.doesNotMatch(artifact.body, /raylink-tokyo-tuic/);
  assert.doesNotMatch(artifact.body, /raylink-invalid-anytls-ws/);
  assert.doesNotMatch(artifact.body, /^proxies:/m);
});

test("Loon preserves the TLS Host identity when every supported protocol dials an IP", () => {
  const tls = { enabled: true, server_name: "node.example.com" };
  const artifact = buildSubscriptionArtifact({
    format: "loon",
    endpointOverrides: { "node.example.com": "203.0.113.20" },
    singBoxConfig: {
      outbounds: [
        {
          type: "vmess",
          tag: "raylink-local-vmess",
          server: "node.example.com",
          server_port: 8443,
          security: "auto",
          uuid: "11111111-1111-4111-8111-111111111111",
          tls
        },
        {
          type: "vless",
          tag: "raylink-local-vless",
          server: "node.example.com",
          server_port: 8444,
          uuid: "22222222-2222-4222-8222-222222222222",
          tls
        },
        {
          type: "trojan",
          tag: "raylink-local-trojan",
          server: "node.example.com",
          server_port: 9443,
          password: "trojan-password",
          tls
        },
        {
          type: "anytls",
          tag: "raylink-local-anytls",
          server: "node.example.com",
          server_port: 8445,
          password: "anytls-password",
          tls
        },
        {
          type: "hysteria2",
          tag: "raylink-local-hysteria2",
          server: "node.example.com",
          server_port: 8448,
          password: "hysteria2-password",
          tls
        }
      ]
    }
  });

  const expectedLines = [
    'raylink-local-vmess=vmess,203.0.113.20,8443,auto,"11111111-1111-4111-8111-111111111111",udp=true,transport=tcp,over-tls=true,sni=node.example.com,skip-cert-verify=false',
    'raylink-local-vless=vless,203.0.113.20,8444,"22222222-2222-4222-8222-222222222222",udp=true,transport=tcp,over-tls=true,sni=node.example.com,skip-cert-verify=false',
    'raylink-local-trojan=trojan,203.0.113.20,9443,"trojan-password",sni=node.example.com,skip-cert-verify=false,udp=true',
    'raylink-local-anytls=anytls,203.0.113.20,8445,"anytls-password",sni=node.example.com,skip-cert-verify=false,udp=true',
    'raylink-local-hysteria2=Hysteria2,203.0.113.20,8448,"hysteria2-password",sni=node.example.com,skip-cert-verify=false,udp=true'
  ];
  assert.deepEqual(artifact.body.trim().split("\n"), expectedLines);
  assert.doesNotMatch(artifact.body, /tls-name=/);
});

test("Egern profile adds smart TCP UDP manual policies, routing and encrypted DNS", () => {
  const artifact = buildSubscriptionArtifact({
    format: "egern-profile",
    singBoxConfig
  });

  assert.equal(artifact.filename, "raylink-egern-profile.yaml");
  assert.match(artifact.body, /^policy_groups:/m);
  assert.match(artifact.body, /- smart:/);
  assert.match(artifact.body, /name: "RayLink 智能"/);
  assert.match(artifact.body, /"\\(\\?i\\)SHADOWSOCKS\\|VLESS\\|TROJAN\\|ANYTLS\\|VMESS": 0\.85/);
  assert.match(artifact.body, /name: "TCP 稳定"/);
  assert.match(artifact.body, /name: "UDP 高速"/);
  assert.match(
    artifact.body,
    /- fallback:[\s\S]*?name: "故障回退"[\s\S]*?policies:[\s\S]*?- "raylink-tokyo-vless"[\s\S]*?- "raylink-tokyo-hysteria2"/
  );
  assert.match(artifact.body, /- conditional:/);
  assert.match(artifact.body, /name: "网络环境"/);
  assert.match(
    artifact.body,
    /cellular:[\s\S]*?match: "\*"[\s\S]*?policy: "故障回退"/
  );
  assert.match(
    artifact.body,
    /ssid:[\s\S]*?match: "\*"[\s\S]*?policy: "故障回退"/
  );
  assert.match(artifact.body, /default_policy: "故障回退"/);
  assert.match(artifact.body, /- select:/);
  assert.match(artifact.body, /name: "手动选择"/);
  assert.match(artifact.body, /name: "AI 网站代理"/);
  assert.match(artifact.body, /^rules:/m);
  assert.match(artifact.body, /match: "openai.com"/);
  assert.match(
    artifact.body,
    /match: "openai\.com"[\s\S]*?policy: "AI 网站代理"/
  );
  assert.match(artifact.body, /match: "baidu\.com"/);
  assert.match(artifact.body, /policy: "DIRECT"/);
  assert.match(artifact.body, /default:[\s\S]*?policy: "未分类流量"/);
  assert.match(artifact.body, /^dns:/m);
  assert.ok(artifact.body.includes("https://1.1.1.1/dns-query"));
  assert.match(artifact.body, /bypass_tunnel_proxy:[\s\S]*?- "\*\.local"/);
  assert.match(artifact.body, /match: "192\.168\.0\.0\/16"[\s\S]*?policy: "DIRECT"/);
});

test("server-healthy UDP never overrides TCP-first client fallback in Mihomo and Egern", () => {
  const healthyConfig = {
    ...singBoxConfig,
    outbounds: singBoxConfig.outbounds.map((outbound) => (
      outbound.tag === "raylink-smart"
        ? {
            ...outbound,
            outbounds: ["raylink-tokyo-vless", "raylink-tokyo-hysteria2"]
          }
        : outbound
    ))
  };
  const mihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig: healthyConfig
  }).body;
  const egern = buildSubscriptionArtifact({
    format: "egern-profile",
    singBoxConfig: healthyConfig
  }).body;

  assert.match(
    mihomo,
    /name: "故障回退"[\s\S]*?proxies:[\s\S]*?- "raylink-tokyo-vless"[\s\S]*?- "raylink-tokyo-hysteria2"/
  );
  assert.match(
    egern,
    /name: "故障回退"[\s\S]*?policies:[\s\S]*?- "raylink-tokyo-vless"[\s\S]*?- "raylink-tokyo-hysteria2"/
  );
});

test("UDP-only subscriptions never emit a dangling TCP policy group", () => {
  const udpOnlyConfig = {
    outbounds: [
      singBoxConfig.outbounds.find((outbound) => outbound.tag === "raylink-tokyo-hysteria2"),
      {
        type: "urltest",
        tag: "raylink-smart",
        outbounds: ["raylink-tokyo-hysteria2"]
      },
      {
        type: "urltest",
        tag: "raylink-udp",
        outbounds: ["raylink-tokyo-hysteria2"]
      }
    ]
  };
  const mihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig: udpOnlyConfig
  }).body;
  const egern = buildSubscriptionArtifact({
    format: "egern-profile",
    singBoxConfig: udpOnlyConfig
  }).body;

  assert.doesNotMatch(mihomo, /name: "TCP 稳定"/);
  assert.doesNotMatch(egern, /name: "TCP 稳定"/);
  assert.match(
    mihomo,
    /name: "故障回退"[\s\S]*?proxies:[\s\S]*?- "raylink-tokyo-hysteria2"/
  );
  assert.match(
    egern,
    /cellular:[\s\S]*?policy: "故障回退"/
  );
});

test("Mihomo and Egern inherit the probe URL from the unified sing-box route policy", () => {
  const probeUrl = "https://probe.example.com/generate_204";
  const configured = {
    ...singBoxConfig,
    outbounds: singBoxConfig.outbounds.map((outbound) => (
      outbound.type === "urltest" ? { ...outbound, url: probeUrl } : outbound
    ))
  };

  const mihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig: configured
  }).body;
  const egern = buildSubscriptionArtifact({
    format: "egern-profile",
    singBoxConfig: configured
  }).body;

  assert.ok(mihomo.includes(`url: "${probeUrl}"`));
  assert.ok(egern.includes(`latency_test_url: "${probeUrl}"`));
  assert.ok(!mihomo.includes("https://www.gstatic.com/generate_204"));
  assert.ok(!egern.includes("https://www.gstatic.com/generate_204"));
});

test("Mihomo, Egern and Loon exporters cover every compatible RayLink public protocol", () => {
  const sharedConfig = {
    outbounds: [
      {
        type: "shadowsocks",
        tag: "shared-ss",
        server: "node.example.com",
        server_port: 8388,
        method: "2022-blake3-aes-128-gcm",
        password: "c2hhcmVkLWtleS0xNg=="
      },
      {
        type: "vmess",
        tag: "shared-vmess",
        server: "node.example.com",
        server_port: 8443,
        uuid: "22222222-2222-4222-8222-222222222222",
        security: "auto"
      },
      {
        type: "trojan",
        tag: "shared-trojan",
        server: "node.example.com",
        server_port: 9443,
        password: "trojan-password",
        tls: { enabled: true, server_name: "node.example.com" }
      },
      {
        type: "anytls",
        tag: "shared-anytls",
        server: "node.example.com",
        server_port: 8445,
        password: "anytls-password",
        tls: { enabled: true, server_name: "node.example.com" }
      },
      {
        type: "tuic",
        tag: "shared-tuic",
        server: "node.example.com",
        server_port: 8447,
        uuid: "33333333-3333-4333-8333-333333333333",
        password: "tuic-password",
        tls: { enabled: true, server_name: "node.example.com" }
      },
      {
        type: "hysteria",
        tag: "mihomo-only-hysteria",
        server: "node.example.com",
        server_port: 8446,
        auth_str: "hysteria-auth",
        tls: { enabled: true, server_name: "node.example.com" }
      }
    ]
  };

  const mihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig: sharedConfig
  }).body;
  for (const type of ["ss", "vmess", "trojan", "anytls", "tuic", "hysteria"]) {
    assert.match(mihomo, new RegExp(`type: "${type}"`));
  }

  const egern = buildSubscriptionArtifact({
    format: "egern",
    singBoxConfig: sharedConfig
  }).body;
  for (const type of ["shadowsocks", "vmess", "trojan", "anytls", "tuic"]) {
    assert.match(egern, new RegExp(`- ${type}:`));
  }
  assert.doesNotMatch(egern, /hysteria:/);

  const loon = buildSubscriptionArtifact({
    format: "loon",
    singBoxConfig: sharedConfig
  }).body;
  for (const type of ["shadowsocks", "vmess", "trojan", "anytls"]) {
    assert.match(loon, new RegExp(`=${type},`));
  }
  assert.doesNotMatch(loon, /=tuic,/i);
  assert.doesNotMatch(loon, /=hysteria,/i);
});

test("TUIC format conversion does not invent ALPN for an externally supplied outbound", () => {
  const config = {
    outbounds: [{
      type: "tuic",
      tag: "raylink-tuic",
      server: "node.example.com",
      server_port: 8447,
      uuid: "33333333-3333-4333-8333-333333333333",
      password: "tuic-password",
      tls: {
        enabled: true,
        server_name: "node.example.com"
      }
    }]
  };

  const mihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig: config
  }).body;
  const egern = buildSubscriptionArtifact({
    format: "egern",
    singBoxConfig: config
  }).body;

  assert.doesNotMatch(mihomo, /alpn:/);
  assert.doesNotMatch(egern, /alpn:/);
  assert.match(mihomo, /sni: "node\.example\.com"/);
  assert.doesNotMatch(mihomo, /servername:/);
  assert.match(mihomo, /heartbeat-interval: 10000/);
  assert.match(mihomo, /request-timeout: 8000/);
});

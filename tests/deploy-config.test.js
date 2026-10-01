import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production Caddy entry point preserves private subscription URLs", async () => {
  const config = await readFile(
    new URL("../deploy/caddy-first-run.Caddyfile", import.meta.url),
    "utf8"
  );
  const installer = await readFile(
    new URL("../deploy/install-control-plane.sh", import.meta.url),
    "utf8"
  );
  const environmentExample = await readFile(
    new URL("../deploy/raylink.env.example", import.meta.url),
    "utf8"
  );

  assert.match(config, /^:443 \{/m);
  assert.match(
    config,
    /tls \/etc\/caddy\/raylink\/control-plane\.crt \/etc\/caddy\/raylink\/control-plane\.key/
  );
  assert.match(config, /http:\/\/__RAYLINK_PUBLIC_HOST__ \{/);
  assert.match(config, /redir https:\/\/__RAYLINK_PUBLIC_HOST__\{uri\} permanent/);
  assert.match(config, /reverse_proxy 127\.0\.0\.1:4173/);
  assert.doesNotMatch(config, /^\s*log\s/m);
  assert.match(installer, /apt-get install -y .*caddy/);
  assert.match(installer, /65760C51EDEA2017CEA2CA15155B6D79CA56EA34/);
  assert.match(installer, /Caddyfile\.before-raylink/);
  assert.match(installer, /RAYLINK_SUBSCRIPTION_ORIGIN=\$\{public_origin\}/);
  assert.match(installer, /RAYLINK_LOCAL_HOST_DIAL_ADDRESS=\$\{public_ip\}/);
  assert.match(installer, /RAYLINK_ENDPOINT_DNS_SERVERS=1\.1\.1\.1,8\.8\.8\.8/);
  assert.match(installer, /RAYLINK_ENDPOINT_DNS_TIMEOUT_MS=2000/);
  assert.match(installer, /RAYLINK_ENDPOINT_PROBE_TIMEOUT_MS=1500/);
  assert.match(installer, /caddy validate --config "\$managed_root\/Caddyfile" --adapter caddyfile/);
  assert.match(installer, /ufw allow 80\/tcp/);
  assert.match(installer, /ufw allow 443\/tcp/);
  assert.match(installer, /systemctl enable --now caddy/);
  assert.doesNotMatch(installer, /systemctl enable --now nginx/);
  assert.match(environmentExample, /RAYLINK_SUBSCRIPTION_ORIGIN=https:\/\/sub\.example\.com/);
  assert.match(environmentExample, /RAYLINK_PROXY_HOST=node\.example\.com/);
  assert.match(environmentExample, /RAYLINK_LOCAL_HOST_DIAL_ADDRESS=203\.0\.113\.10/);
  assert.match(environmentExample, /RAYLINK_ENDPOINT_DNS_SERVERS=1\.1\.1\.1,8\.8\.8\.8/);
});

test("systemd sandboxes permit only RayLink-managed UFW rule files", async () => {
  const installer = await readFile(
    new URL("../deploy/install-control-plane.sh", import.meta.url),
    "utf8"
  );
  const service = await readFile(
    new URL("../deploy/raylink.service", import.meta.url),
    "utf8"
  );
  const nodeInstaller = await readFile(
    new URL("../web/node/install.sh", import.meta.url),
    "utf8"
  );
  const firewallTmpfiles = await readFile(
    new URL("../web/node/raylink-ufw.tmpfiles.conf", import.meta.url),
    "utf8"
  );

  assert.match(installer, /systemd-tmpfiles --create \/usr\/lib\/tmpfiles\.d\/raylink-ufw\.conf/);
  assert.match(
    service,
    /ReadWritePaths=\/var\/lib\/raylink \/usr\/local\/bin -\/run\/ufw\.lock -\/run\/xtables\.lock -\/etc\/ufw\/user\.rules -\/etc\/ufw\/user6\.rules/
  );
  assert.doesNotMatch(service, /ReadWritePaths=.*\/etc\/caddy(?:\s|$)/);
  assert.doesNotMatch(service, /ReadWritePaths=.*\/etc\/raylink(?:\s|$)/);
  assert.match(
    nodeInstaller,
    /ReadWritePaths=\$RAYLINK_NODE_CONFIG_ROOT \$RAYLINK_NODE_DATA_ROOT \$RAYLINK_NODE_ROOT \$RAYLINK_RUNTIME_BIN_DIR -\/run\/ufw\.lock -\/run\/xtables\.lock -\/etc\/ufw\/user\.rules -\/etc\/ufw\/user6\.rules/
  );
  assert.match(
    nodeInstaller,
    /download "\$RAYLINK_SERVER\/node\/raylink-ufw\.tmpfiles\.conf"/
  );
  assert.match(
    nodeInstaller,
    /systemd-tmpfiles --create "\$RAYLINK_TMPFILES_ROOT\/raylink-node-ufw\.conf"/
  );
  assert.match(firewallTmpfiles, /^f \/run\/ufw\.lock 0644 root root -$/m);
  assert.match(firewallTmpfiles, /^f \/run\/xtables\.lock 0600 root root -$/m);
});

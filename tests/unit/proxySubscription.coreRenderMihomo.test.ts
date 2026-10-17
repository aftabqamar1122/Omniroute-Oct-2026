import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";

const { parseSubscription } = await import("../../src/lib/proxySubscription/parse.ts");
const { buildCoreModel, normalizeSource } =
  await import("../../src/lib/proxySubscription/coreConfig/model.ts");
const { renderSingBox, projectCanonical } =
  await import("../../src/lib/proxySubscription/coreConfig/singbox.ts");
const mihomo = await import("../../src/lib/proxySubscription/coreConfig/mihomo.ts");
const renderers = await import("../../src/lib/proxySubscription/coreConfig/renderers.ts");

const ENTRIES = ["socks5://127.0.0.1:1080 selector=a", "socks5://127.0.0.1:1081 selector=b"];

function renderFromFeed(body: string, entries: string[] = ENTRIES) {
  const parsed = parseSubscription(body);
  const model = buildCoreModel(entries, [...parsed.nodes, ...parsed.needsCore] as never);
  return { model, result: mihomo.renderMihomo(model, null) };
}

test("a standard vless URI renders as a mihomo proxy with the same content as sing-box", () => {
  const parsed = parseSubscription(
    "vless://11111111-2222-4333-8444-555555555555@example.com:443?security=tls#std"
  );
  const model = buildCoreModel(ENTRIES, [...parsed.nodes, ...parsed.needsCore] as never);
  assert.equal(model.nodes.length, 1);
  const mRes = mihomo.renderMihomo(model, null);
  assert.equal(mRes.ok, true);
  if (!mRes.ok) return;
  const sRes = renderSingBox(model, null);
  assert.equal(sRes.ok, true);
  if (!sRes.ok) return;
  const after = yaml.load(mRes.text) as {
    proxies: Array<{ type: string; server: string; port: number; uuid: string; name: string }>;
  };
  const proxy = after.proxies.find(
    (p: { type: string; server: string; port: number }) =>
      p.type === "vless" && p.server === "example.com" && p.port === 443
  );
  assert.ok(proxy, `expected a vless proxy, got: ${mRes.text}`);
  assert.equal(proxy.uuid, "11111111-2222-4333-8444-555555555555");
  assert.equal(mRes.skipped.filter((s) => s.reason === "converter_unsupported").length, 0);
  // Same content as sing-box, mapped field by field.
  const sAfter = JSON.parse((sRes as { text: string }).text);
  const outbound = sAfter.outbounds.find(
    (o: { type: string; server: string; server_port: number }) =>
      o.type === "vless" && o.server === "example.com" && o.server_port === 443
  );
  assert.ok(outbound, `expected a vless outbound, got: ${(sRes as { text: string }).text}`);
  assert.equal(proxy.uuid, outbound.uuid);
  assert.equal(proxy.server, outbound.server);
  assert.equal(proxy.port, outbound.server_port);
});

function parsedYaml(
  text: string
): { proxies: Array<{ type: string; name: string }> } & Record<string, unknown> {
  return yaml.load(text) as { proxies: Array<{ type: string; name: string }> } & Record<
    string,
    unknown
  >;
}

test("a vmess clash object renders as a mihomo proxy", () => {
  const { result } = renderFromFeed(`proxies:
  - name: "named"
    type: vmess
    server: 203.0.113.9
    port: 443
    uuid: 11111111-2222-4333-8444-555555555555
`);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const after = parsedYaml(result.text);
  const proxy = after.proxies.find((p) => p.type === "vmess") as { uuid: string };
  assert.ok(proxy, `expected a vmess proxy, got: ${result.text}`);
  assert.equal(proxy.uuid, "11111111-2222-4333-8444-555555555555");
});

test("a node with an unsupported field is rejected whole with a reason, never guessed", () => {
  const { result } = renderFromFeed(
    "vless://11111111-2222-4333-8444-555555555555@example.com:443?mystery=1#unknown"
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rejected = result.skipped.filter((s) => s.reason === "converter_unsupported");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].detail, "unknown-param:mystery");
  const after = parsedYaml(result.text);
  assert.deepEqual(after.proxies, []);
});

test("clash trojan, ss, vmess and hysteria2 objects share the rendered proxy shape", () => {
  const body = `proxies:
  - name: "clash-trojan"
    type: trojan
    server: 203.0.113.11
    port: 8443
    password: trojan-secret
  - name: "clash-ss"
    type: ss
    server: 203.0.113.12
    port: 8388
    cipher: aes-256-gcm
    password: ss-secret
  - name: "clash-vmess"
    type: vmess
    server: 203.0.113.13
    port: 443
    uuid: 11111111-2222-4333-8444-555555555555
  - name: "clash-hysteria2"
    type: hysteria2
    server: 203.0.113.14
    port: 8443
    password: hy-secret
`;
  const { result } = renderFromFeed(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const after = parsedYaml(result.text);
  const names = after.proxies.map((p) => p.name);
  for (const name of ["clash-trojan", "clash-ss", "clash-vmess", "clash-hysteria2"]) {
    assert.ok(
      names.some((n) => n.includes(name)),
      `expected a rendered proxy for ${name}, got names: ${names.join(",")}`
    );
  }
  assert.equal(result.skipped.filter((s) => s.reason === "converter_unsupported").length, 0);
});

test("the clash corpus renders at the same rate as sing-box with zero exceptions", () => {
  const bodies = [
    "vless://11111111-2222-4333-8444-555555555555@example.com:443?security=tls#std",
    "hysteria2://secret@example.com:8443?obfs=salamander&obfs-password=x#obfs",
    "vless://11111111-2222-4333-8444-555555555555@example.com:443?mystery=1#unknown",
    "vless://u@example.com:443?flow=xtls-rprx-vision-udp443#bad",
    `proxies:
  - name: "clash-trojan"
    type: trojan
    server: 203.0.113.11
    port: 8443
    password: trojan-secret
  - name: "clash-ss"
    type: ss
    server: 203.0.113.12
    port: 8388
    cipher: aes-256-gcm
    password: ss-secret
  - name: "clash-vmess"
    type: vmess
    server: 203.0.113.13
    port: 443
    uuid: 11111111-2222-4333-8444-555555555555
  - name: "clash-hysteria2"
    type: hysteria2
    server: 203.0.113.14
    port: 8443
    password: hy-secret
`,
    "vless://u@example.com:443?flow=xtls-rprx-vision-udp443#irreducible",
    "vless://11111111-2222-4333-8444-555555555555@example.com:443?remark=hello#named",
  ];
  for (const body of bodies) {
    const parsed = parseSubscription(body);
    const model = buildCoreModel(ENTRIES, [...parsed.nodes, ...parsed.needsCore] as never);
    const mRes = mihomo.renderMihomo(model, null);
    assert.equal(mRes.ok, true);
    if (!mRes.ok) continue;
    const sRes = renderSingBox(model, null);
    assert.equal(sRes.ok, true);
    if (!sRes.ok) continue;
    const mRendered = model.nodes.filter((n) =>
      (mRes as { text: string }).text.includes(`omniroute-${n.tag}`)
    ).length;
    const sRendered = model.nodes.filter((n) =>
      (sRes as { text: string }).text.includes(`omniroute-${n.tag}`)
    ).length;
    assert.equal(mRendered, sRendered, `rate mismatch for feed: ${body.slice(0, 60)}`);
    assert.deepEqual(
      [...mRes.skipped.map((s) => s.reason)].sort(),
      [...sRes.skipped.map((s) => s.reason)].sort(),
      `skip reasons mismatch for feed: ${body.slice(0, 60)}`
    );
  }
});

test("projectCanonicalMihomo mirrors projectCanonical field by field", () => {
  const parsed = parseSubscription(
    "vless://11111111-2222-4333-8444-555555555555@example.com:443?security=tls#std"
  );
  const model = buildCoreModel(ENTRIES, [...parsed.nodes, ...parsed.needsCore] as never);
  const verdict = normalizeSource(model.nodes[0].source);
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  const mProxy = mihomo.projectCanonicalMihomo(verdict.node);
  const sOutbound = projectCanonical(verdict.node);
  assert.equal(mProxy.server, sOutbound.server);
  assert.equal(mProxy.port, sOutbound.server_port);
  assert.equal(mProxy.uuid, (sOutbound as { uuid: string }).uuid);
});

test("refuses empty, malformed, non-object and section-less bases like sing-box", () => {
  const { model } = renderFromFeed(
    "vless://11111111-2222-4333-8444-555555555555@example.com:443?security=tls#std"
  );
  const emptySection = mihomo.renderMihomo(model, "proxies: []");
  assert.equal(emptySection.ok, true);
  if (!emptySection.ok) return;
  assert.deepEqual(parsedYaml(emptySection.text).proxies.length, 1);
  assert.deepEqual(mihomo.renderMihomo(model, "not yaml {{{: ["), {
    ok: false,
    reason: "unparseable",
  });
  assert.deepEqual(mihomo.renderMihomo(model, "- just\n- a\n- list\n"), {
    ok: false,
    reason: "not_an_object",
  });
  assert.deepEqual(mihomo.renderMihomo(model, "dns:\n  servers: []\n"), {
    ok: false,
    reason: "no_ownable_section",
  });
});

test("keeps operator sections verbatim and reports group empties", () => {
  const { model } = renderFromFeed("vless://u@10.3.0.2:443?flow=bogus#x", [
    "socks5://127.0.0.1:1080 selector=solo",
  ]);
  const base =
    "dns:\n  nameserver:\n    - https://1.1.1.1/dns-query\nproxies:\n  - name: keep-me\n    type: direct\n";
  const res = mihomo.renderMihomo(model, base);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.text.includes("keep-me"));
  assert.ok(res.text.includes("https://1.1.1.1/dns-query"));
  assert.equal(res.skipped.filter((s) => s.reason === "empty_group").length, 1);
});

test("second render is unchanged", () => {
  const { model } = renderFromFeed(
    "vless://11111111-2222-4333-8444-555555555555@example.com:443?security=tls#std"
  );
  const first = mihomo.renderMihomo(model, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.unchanged, false);
  const second = mihomo.renderMihomo(model, first.text);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.unchanged, true);
  assert.equal(second.text, first.text);
});

test("the mihomo entry is registered without changing the default", () => {
  assert.equal(renderers.DEFAULT_CORE, "sing-box");
  assert.equal(renderers.RENDERERS["mihomo"], mihomo.renderMihomo);
  assert.equal(renderers.RENDERERS["sing-box"], renderSingBox);
  assert.equal(renderers.OFFENDING_RESOLVERS["mihomo"], mihomo.resolveMihomoTag);
  assert.equal(renderers.RENDERERS["mihomo"].apiReload, false);
});

test("rendererFor resolves yaml targets to mihomo and anything else to the default", () => {
  assert.equal(renderers.rendererFor("core.yaml").core, "mihomo");
  assert.equal(renderers.rendererFor("core.yaml").renderer, mihomo.renderMihomo);
  assert.equal(renderers.rendererFor("core.yml").core, "mihomo");
  assert.equal(renderers.rendererFor("core.json").core, renderers.DEFAULT_CORE);
  assert.equal(renderers.rendererFor("core.YAML").core, renderers.DEFAULT_CORE);
});

test("resolveMihomoTag maps a named proxy position to its node tag", () => {
  const table = [null, "node-a", null];
  const mark = mihomo.resolveMihomoTag("FATAL parse proxies[1]: rejected field value", table);
  assert.deepEqual(mark, { tag: "node-a", token: "offending-pattern:proxies[1]" });
  assert.equal(mihomo.resolveMihomoTag("FATAL parse proxies[0]: rejected", table), null);
  assert.equal(mihomo.resolveMihomoTag("FATAL parse proxies[7]: rejected", table), null);
  assert.equal(mihomo.resolveMihomoTag("FATAL: configuration missing", table), null);
  const first = mihomo.resolveMihomoTag("proxies[1] then proxies[0]", table);
  assert.deepEqual(first, { tag: "node-a", token: "offending-pattern:proxies[1]" });
});

test("sync renders yaml targets with mihomo and json targets with sing-box", async (t) => {
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-core-mihomo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const feed = {
    nodes: [],
    needsCore: [
      {
        name: "sb-node-1",
        source: {
          kind: "object" as const,
          value: { type: "vless", server: "203.0.113.1", server_port: 443, uuid: "u-1" },
        },
      },
    ] as never[],
    format: "v2ray-json",
  };
  const yamlTarget = path.join(dir, "core.yaml");
  fs.writeFileSync(yamlTarget, "proxies: []\n");
  const yamlWarning = await sync.generateForSubscription(
    { coreConfigPath: yamlTarget, localCoreEndpoint: ENTRIES[0] },
    feed
  );
  assert.equal(yamlWarning, null);
  const yamlGenerated = fs.readFileSync(`${yamlTarget}.generated`, "utf8");
  assert.ok(yamlGenerated.includes("proxies:"), `got: ${yamlGenerated.slice(0, 120)}`);
  const jsonTarget = path.join(dir, "core.json");
  fs.writeFileSync(jsonTarget, JSON.stringify({ inbounds: [], outbounds: [] }));
  const jsonWarning = await sync.generateForSubscription(
    { coreConfigPath: jsonTarget, localCoreEndpoint: ENTRIES[0] },
    feed
  );
  assert.equal(jsonWarning, null);
  const jsonGenerated = fs.readFileSync(`${jsonTarget}.generated`, "utf8");
  assert.ok(!jsonGenerated.includes("proxies:"), `got: ${jsonGenerated.slice(0, 120)}`);
});

test("an uppercase yaml suffix resolves to the default core", async (t) => {
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-core-mihomo-case-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const feed = {
    nodes: [],
    needsCore: [
      {
        name: "sb-node-1",
        source: {
          kind: "object" as const,
          value: { type: "vless", server: "203.0.113.1", server_port: 443, uuid: "u-1" },
        },
      },
    ] as never[],
    format: "v2ray-json",
  };
  const target = path.join(dir, "core.YAML");
  fs.writeFileSync(target, JSON.stringify({ inbounds: [], outbounds: [] }));
  const warning = await sync.generateForSubscription(
    { coreConfigPath: target, localCoreEndpoint: ENTRIES[0] },
    feed
  );
  assert.equal(warning, null);
  const generated = fs.readFileSync(`${target}.generated`, "utf8");
  assert.ok(!generated.includes("proxies:"), `got: ${generated.slice(0, 120)}`);
});

test("the native check table carries a mihomo entry", async () => {
  const { checkArgsFor, CORE_CHECK_ARGS } =
    await import("../../src/lib/proxySubscription/coreConfig/pathGuard.ts");
  assert.deepEqual(checkArgsFor("mihomo"), ["-t", "-f"]);
  assert.equal(checkArgsFor("sing-box")?.join(" "), "check -c");
  assert.ok("mihomo" in CORE_CHECK_ARGS);
});

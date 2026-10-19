// electron-builder 的真实下载依赖：子进程隔离 global-agent 对 http/https 的全局修改。
// HTTP cache 用例是显式启用缓存后的兼容合同，不声称修复 max-stale 的上游争议。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { KeyObject, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Integer, OctetString, Utf8String } from "asn1js";
import { AttributeTypeAndValue, Certificate, Extension, GeneralName, GeneralNames, getCrypto } from "pkijs";

const exec = promisify(execFile);
const childSetup = String.raw`
  const { createRequire } = require("node:module");
  const builderRequire = createRequire(require.resolve("app-builder-lib"));
  const getRequire = createRequire(builderRequire.resolve("@electron/get"));
`;

// 不继承开发者代理或 TLS 放行设置；每个子进程只使用本用例声明的代理与 CA。
async function runConsumer(source: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(global_agent_|https?_proxy$|all_proxy$|no_proxy$|node_extra_ca_certs$)/i.test(key),
    ),
  );
  const { stdout } = await exec(process.execPath, ["-e", `${childSetup}\n${source}`], {
    cwd: process.cwd(),
    env: { ...env, NODE_TLS_REJECT_UNAUTHORIZED: "1", ...extraEnv },
    timeout: 6000,
    maxBuffer: 64 * 1024,
  });
  return JSON.parse(stdout);
}

describe("electron-builder 下载依赖的代理、TLS 与 HTTP cache 合同", () => {
  let temp: string;
  let certificate: string;
  let origin: http.Server;
  let secureOrigin: https.Server;
  let proxy: http.Server;
  let originUrl: string;
  let secureUrl: string;
  let proxyUrl: string;
  const sockets = new Set<net.Socket>();
  const hits = new Map<string, number>();
  const proxyRequests: string[] = [];
  const tunnels: string[] = [];

  async function listen(server: http.Server | https.Server) {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("预期本地 TCP 地址");
    return `127.0.0.1:${address.port}`;
  }

  beforeAll(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "bunkiten-dependency-"));
    certificate = path.join(temp, "localhost.crt");
    // 复用锁定依赖和 Node WebCrypto；跨平台生成证书，私钥只留在内存。
    const engine = getCrypto(true);
    const keys = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const tlsCertificate = new Certificate();
    tlsCertificate.version = 2;
    tlsCertificate.serialNumber = new Integer({ value: 1 });
    tlsCertificate.subject.typesAndValues.push(
      new AttributeTypeAndValue({ type: "2.5.4.3", value: new Utf8String({ value: "localhost" }) }),
    );
    tlsCertificate.issuer = tlsCertificate.subject;
    tlsCertificate.notBefore.value = new Date(Date.now() - 60_000);
    tlsCertificate.notAfter.value = new Date(Date.now() + 86_400_000);
    tlsCertificate.extensions = [
      new Extension({
        extnID: "2.5.29.17",
        extnValue: new GeneralNames({
          names: [
            new GeneralName({ type: 7, value: new OctetString({ valueHex: Uint8Array.of(127, 0, 0, 1).buffer }) }),
          ],
        })
          .toSchema()
          .toBER(false),
      }),
    ];
    await tlsCertificate.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
    await tlsCertificate.sign(keys.privateKey, "SHA-256", engine);
    const cert = new X509Certificate(Buffer.from(tlsCertificate.toSchema().toBER(false))).toString();
    await writeFile(certificate, cert);
    origin = http.createServer((req, res) => {
      const route = req.url ?? "/";
      const count = (hits.get(route) ?? 0) + 1;
      hits.set(route, count);
      const cacheControl =
        route === "/private" ? "private, max-age=300" : route === "/public" ? "public, max-age=300" : "no-store";
      res.writeHead(200, { "cache-control": cacheControl });
      res.end(`${req.headers["x-visitor"] ?? "download"}:${count}`);
    });
    secureOrigin = https.createServer(
      { key: KeyObject.from(keys.privateKey).export({ type: "pkcs8", format: "pem" }), cert },
      (_req, res) => res.end("secure-download"),
    );
    originUrl = `http://${await listen(origin)}`;
    secureUrl = `https://${await listen(secureOrigin)}`;
    proxy = http.createServer((req, res) => {
      proxyRequests.push(req.url ?? "");
      const upstream = http.request(
        req.url ?? "",
        { method: req.method, headers: req.headers, agent: false },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    proxy.on("connect", (req, client, head) => {
      tunnels.push(req.url ?? "");
      const target = new URL(`http://${req.url}`);
      const upstream = net.connect(Number(target.port), target.hostname, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
    });
    proxyUrl = `http://${await listen(proxy)}`;
  }, 15_000);

  beforeEach(() => {
    hits.clear();
    proxyRequests.length = 0;
    tunnels.length = 0;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [origin, secureOrigin, proxy]
        .filter(Boolean)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  async function download(url: string, extraEnv: NodeJS.ProcessEnv = {}) {
    return runConsumer(
      String.raw`
      const fs = require("node:fs");
      getRequire("./proxy.js").initializeProxy();
      const { GotDownloader } = getRequire("./GotDownloader.js");
      new GotDownloader().download(process.env.DOWNLOAD_URL, process.env.DOWNLOAD_FILE,
        { retry: 0, timeout: { request: 2000 }, quiet: true })
        .then(() => console.log(JSON.stringify({ body: fs.readFileSync(process.env.DOWNLOAD_FILE, "utf8") })))
        .catch(error => console.log(JSON.stringify({ error: error.code })));
    `,
      {
        GLOBAL_AGENT_HTTP_PROXY: proxyUrl,
        GLOBAL_AGENT_HTTPS_PROXY: proxyUrl,
        ELECTRON_GET_NO_PROGRESS: "1",
        DOWNLOAD_URL: url,
        DOWNLOAD_FILE: path.join(temp, "download.bin"),
        ...extraEnv,
      },
    );
  }

  it("原始 bootstrap 和 GotDownloader 的 HTTP 下载实际经过代理", async () => {
    expect(await download(`${originUrl}/download`)).toEqual({ body: "download:1" });
    expect(proxyRequests).toEqual([`${originUrl}/download`]);
    expect(hits.get("/download")).toBe(1);
  }, 10_000);

  it("GLOBAL_AGENT_NO_PROXY 让指定主机直接下载", async () => {
    expect(await download(`${originUrl}/download`, { GLOBAL_AGENT_NO_PROXY: "127.0.0.1" })).toEqual({
      body: "download:1",
    });
    expect(proxyRequests).toEqual([]);
    expect(hits.get("/download")).toBe(1);
  }, 10_000);

  it("HTTPS 经 CONNECT，默认拒绝不可信证书；显式信任测试 CA 后成功", async () => {
    expect(await download(`${secureUrl}/download`)).toEqual({ error: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(await download(`${secureUrl}/download`, { NODE_EXTRA_CA_CERTS: certificate })).toEqual({
      body: "secure-download",
    });
    expect(tunnels).toEqual([new URL(secureUrl).host, new URL(secureUrl).host]);
    expect(proxyRequests).toEqual([]);
  }, 15_000);

  it.each(["private", "no-store", "public"])(
    "got 所用真实 cacheable-request 的 %s 缓存合同",
    async (policy) => {
      const bodies = await runConsumer(
        String.raw`
      (async () => {
        const gotRequire = createRequire(getRequire.resolve("got"));
        const CacheableRequest = gotRequire("cacheable-request");
        const request = new CacheableRequest(require("node:http").request, new Map());
        const bodies = [];
        for (const visitor of ["first", "second"]) {
          bodies.push(await new Promise((resolve, reject) => {
            request({
              ...require("node:url").urlToHttpOptions(new URL(process.env.CACHE_URL)),
              headers: { "x-visitor": visitor },
            }, response => {
              let body = "";
              response.on("data", chunk => { body += chunk; });
              response.on("error", reject);
              response.on("end", () => resolve({ body, cached: response.fromCache }));
            }).on("request", req => {
              req.setTimeout(2000, () => req.destroy(new Error("cache request timeout")));
              req.on("error", reject);
              req.end();
            }).on("error", reject);
          }));
          // 写入缓存发生在响应 end 后的异步链；下一轮事件开始后再发第二个请求。
          await require("node:timers/promises").setImmediate();
        }
        console.log(JSON.stringify(bodies));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
        { CACHE_URL: `${originUrl}/${policy}` },
      );
      expect(bodies).toEqual([
        { body: "first:1", cached: false },
        { body: policy === "public" ? "first:1" : "second:2", cached: policy === "public" },
      ]);
      expect(hits.get(`/${policy}`)).toBe(policy === "public" ? 1 : 2);
    },
    10_000,
  );
});

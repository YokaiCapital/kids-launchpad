import { createServer } from "node:http";
import { constants, generateKeyPairSync, privateDecrypt, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstatSync, readFileSync } from "node:fs";
import { MINT_REFILL_POLICY } from "./mint-refill-core.js";
export function isMintGenerationPaused() {
    try {
        const path = "/data/vanity/refill-paused.json", stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 || (stat.mode & 0o077) !== 0)
            return true;
        const value = JSON.parse(readFileSync(path, "utf8"));
        return value.paused !== false;
    }
    catch (error) {
        return error.code !== "ENOENT";
    }
}
export function isPrivateMintImportAddress(address) {
    if (/^f[cd][0-9a-f]{2}:/i.test(address))
        return true;
    const parts = address.split(".").map(Number);
    return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
        && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
/** The private transport key is ephemeral. It cannot decrypt the inventory.
 * Restart may discard an unacknowledged fresh candidate; stored mints persist.
 * This server has no mint-secret export, reservation, signing or funding route.
 */
export function createMintImportServer(options) {
    if (options.token.length !== 32)
        throw Error("Invalid import authentication");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const server = createServer({ maxHeaderSize: 2048, requestTimeout: 5000, headersTimeout: 5000 }, async (request, response) => {
        const reply = (status, data) => {
            if (response.destroyed || response.writableEnded)
                return;
            response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify(data));
        };
        let supplied, clear;
        try {
            const header = request.headers.authorization;
            if (typeof header !== "string" || !/^Bearer [a-f0-9]{64}$/.test(header)) {
                request.resume();
                reply(401, { error: "unauthorized" });
                return;
            }
            supplied = Buffer.from(header.slice(7), "hex");
            if (!timingSafeEqual(supplied, options.token)) {
                request.resume();
                reply(401, { error: "unauthorized" });
                return;
            }
            if (request.method === "GET" && request.url === "/status") {
                request.resume();
                reply(200, { version: 1, target: MINT_REFILL_POLICY.targetAvailable, ...options.status(), publicKeyPem });
                return;
            }
            if (request.method !== "POST" || request.url !== "/import") {
                request.resume();
                reply(404, { error: "not-found" });
                return;
            }
            if (!options.status().accepting) {
                request.resume();
                reply(409, { error: "not-accepting" });
                return;
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 1024) {
                    reply(413, { error: "too-large" });
                    request.destroy();
                    return;
                }
                chunks.push(Buffer.from(chunk));
            }
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!value || Object.keys(value).join() !== "envelope" || typeof value.envelope !== "string"
                || !/^[A-Za-z0-9+/]{512}$/.test(value.envelope))
                throw Error("Invalid envelope");
            const encrypted = Buffer.from(value.envelope, "base64");
            if (encrypted.length !== 384)
                throw Error("Invalid envelope");
            clear = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, encrypted);
            if (clear.length !== 64)
                throw Error("Invalid candidate");
            if (!options.status().accepting) {
                reply(409, { error: "not-accepting" });
                return;
            }
            const result = options.importMint(clear);
            reply(result.reason === "full" ? 409 : 200, { accepted: result.reason !== "full", duplicate: result.reason === "duplicate" });
        }
        catch {
            reply(400, { error: "invalid-request" });
        }
        finally {
            supplied?.fill(0);
            clear?.fill(0);
        }
    });
    server.maxConnections = 32;
    server.setTimeout(5000, socket => socket.destroy());
    return server;
}
export async function startPrivateMintImportServer(options) {
    if (!/^[a-z0-9-]+\.railway\.internal$/.test(options.privateDomain))
        throw Error("Private Railway domain required");
    const addresses = await lookup(options.privateDomain, { all: true });
    const host = addresses.find(a => a.family === 6 && isPrivateMintImportAddress(a.address))?.address
        ?? addresses.find(a => isPrivateMintImportAddress(a.address))?.address;
    if (!host)
        throw Error("Private Railway address required");
    const server = createMintImportServer(options);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(9091, host, () => { server.removeListener("error", reject); resolve(); }); });
    return { close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

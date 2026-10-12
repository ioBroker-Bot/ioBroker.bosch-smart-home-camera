/**
 * Old FCM device token is deregistered at CBS after a confirmed token change.
 * Endpoint: PUT /v11/registration/logout?deviceToken=<old> (204). Fake values only.
 */

import { expect } from "chai";
import sinon from "sinon";
import type { ECDH } from "crypto";
import type { AxiosInstance } from "axios";

import { FcmListener, type FcmCredentials, type FcmDeps } from "../../src/lib/fcm";

const OLD_TOKEN = "fake-old-token-aaaa";
const NEW_TOKEN = "fake-new-token-bbbb";

function makeDeps(token = NEW_TOKEN): FcmDeps {
    const ecdh = {
        getPublicKey: () => Buffer.alloc(65, 0x04),
        getPrivateKey: () => Buffer.alloc(32, 0xab),
        setPrivateKey: sinon.stub(),
    } as unknown as ECDH;
    const client = { connect: sinon.stub().resolves(undefined), disconnect: sinon.stub().resolves(), on: sinon.stub() };
    return {
        registerToFCM: sinon.stub().resolves({
            acg: { id: BigInt("11111111222233334444"), securityToken: BigInt("5555666677778888") },
            token,
        }) as unknown as FcmDeps["registerToFCM"],
        createFcmECDH: sinon.stub().returns(ecdh) as unknown as FcmDeps["createFcmECDH"],
        generateFcmAuthSecret: sinon.stub().returns(Buffer.alloc(16, 0x11)) as unknown as FcmDeps["generateFcmAuthSecret"],
        FcmClient: sinon.stub().returns(client) as unknown as FcmDeps["FcmClient"],
        setInterval: () => 0,
        clearInterval: () => undefined,
    };
}

function saved(token: string): FcmCredentials {
    return {
        fcmToken: token,
        mode: "android",
        raw: {
            acgId: "11111111222233334444",
            acgSecurityToken: "5555666677778888",
            authSecret: [1],
            ecdhPrivateKey: [2],
            ecdhPublicKey: [3],
            mode: "android",
        },
    };
}

function makeHttp(opts: { cbs?: number; put?: sinon.SinonStub } = {}) {
    const post = sinon.stub().resolves({ status: opts.cbs ?? 204, data: "" });
    const put = opts.put ?? sinon.stub().resolves({ status: 204, data: "" });
    return { http: { post, put } as unknown as AxiosInstance, post, put };
}

describe("FcmListener — old token logout", () => {
    it("logs out the persisted old token after the new one is confirmed", async () => {
        const { http, put } = makeHttp();
        const l = new FcmListener(http, "bearer", { savedCredentials: saved(OLD_TOKEN) }, makeDeps());
        await l.start();
        await l._logoutPromise;
        expect(put.calledOnce).to.equal(true);
        expect(put.firstCall.args[0]).to.match(/\/v11\/registration\/logout$/);
        expect(put.firstCall.args[2].params).to.deep.equal({ deviceToken: OLD_TOKEN });
        expect(put.firstCall.args[2].headers.Authorization).to.equal("Bearer bearer");
        await l.stop();
    });

    it("does nothing when the token is unchanged or there was no previous token", async () => {
        const a = makeHttp();
        const l1 = new FcmListener(a.http, "b", { savedCredentials: saved(NEW_TOKEN) }, makeDeps());
        await l1.start();
        const b = makeHttp();
        const l2 = new FcmListener(b.http, "b", {}, makeDeps());
        await l2.start();
        expect(a.put.called).to.equal(false);
        expect(b.put.called).to.equal(false);
        await l1.stop();
        await l2.stop();
    });

    it("does not log out when CBS registration is not confirmed", async () => {
        const { http, put } = makeHttp({ cbs: 403 });
        const l = new FcmListener(http, "b", { savedCredentials: saved(OLD_TOKEN) }, makeDeps());
        let failed = false;
        l.on("mode-failed", () => {
            failed = true;
        });
        await l.start().catch(() => undefined);
        expect(failed).to.equal(true);
        expect(put.called).to.equal(false);
    });

    it("never throws, reports without the token, and does not repeat", async () => {
        const put = sinon.stub().rejects(new Error(`boom ${OLD_TOKEN}`));
        const { http } = makeHttp({ put });
        const l = new FcmListener(http, "b", { savedCredentials: saved(OLD_TOKEN) }, makeDeps());
        const logged: string[] = [];
        l.on("error-logged", (m: string) => logged.push(m));
        await l.start();
        await l._logoutPromise;
        await l._logoutToken(OLD_TOKEN);
        expect(put.callCount).to.equal(1);
        expect(logged).to.have.length(1);
        expect(logged[0]).to.not.include(OLD_TOKEN);
        await l.stop();
    });

    it("reports a non-204 status without the token", async () => {
        const put = sinon.stub().resolves({ status: 500, data: "" });
        const { http } = makeHttp({ put });
        const l = new FcmListener(http, "b", { savedCredentials: saved(OLD_TOKEN) }, makeDeps());
        const logged: string[] = [];
        l.on("error-logged", (m: string) => logged.push(m));
        await l.start();
        await l._logoutPromise;
        expect(logged).to.deep.equal(["CBS old-token logout HTTP 500"]);
        await l.stop();
    });
});

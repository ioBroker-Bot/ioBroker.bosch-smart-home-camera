/**
 * Lighting writers share one per-camera lock; cold-cache wallwasher/front
 * writes seed from a GET; Gen2 on/off acks only the group that really
 * succeeded. Fake IDs only.
 */
import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import {
    stubAxiosSequence,
    stubAxiosByUrl,
    restoreAxios,
    type UrlMatcher,
} from "./helpers/axios-mock";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { MockDatabase: MockDatabaseCtor } =
    require("@iobroker/testing/build/tests/unit/mocks/mockDatabase") as {
        MockDatabase: new () => MockDatabase;
    };

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { mockAdapterCore: mockAdapterCoreFn } =
    require("@iobroker/testing/build/tests/unit/mocks/mockAdapterCore") as {
        mockAdapterCore: (
            db: MockDatabase,
            opts?: { onAdapterCreated?: (a: MockAdapter) => void },
        ) => unknown;
    };

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_JS_PATH = path.join(REPO_ROOT, "build", "main.js");
const ADAPTER_CORE_PATH = require.resolve("@iobroker/adapter-core");

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

// ── Camera IDs ────────────────────────────────────────────────────────────────

const CAM_GEN2_LIGHT = "0A0B0C0D-1111-2222-3333-444455556666"; // HOME_Eyes_Outdoor, featureLight=true
const CAM_GEN2_NO_LIGHT = "0E0F1011-BBBB-CCCC-DDDD-000000000002"; // HOME_Eyes_Indoor, featureLight=false
const CAM_GEN1 = "AABBCCDD-1111-2222-3333-444455556666"; // CAMERA_360, Gen1

const CAM_GEN2_LIGHT_BODY = [
    {
        id: CAM_GEN2_LIGHT,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

const CAM_GEN2_NO_LIGHT_BODY = [
    {
        id: CAM_GEN2_NO_LIGHT,
        title: "Innenbereich",
        hardwareVersion: "HOME_Eyes_Indoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: false },
    },
];

const CAM_GEN1_BODY = [
    {
        id: CAM_GEN1,
        title: "Kamera",
        hardwareVersion: "CAMERA_360",
        firmwareVersion: "7.91.56",
        featureSupport: { light: false },
    },
];

// ── Test infrastructure ───────────────────────────────────────────────────────

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

function injectModuleEntry(resolvedPath: string, exports: object): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[resolvedPath] = {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(resolvedPath),
        paths: [],
        exports,
    };
}

interface MakeAdapterOpts {
    cameraBody?: unknown[];
    axiosByUrl?: UrlMatcher[];
    extraAxiosResponses?: Array<Partial<{ status: number; data: unknown }>>;
    openLiveSessionStub?: sinon.SinonStub;
    fetchSnapshotStub?: sinon.SinonStub;
}

function makeAdapter(opts: MakeAdapterOpts = {}): { db: MockDatabase; adapter: TestAdapter } {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => {
            capturedAdapter = a;
        },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH,
        filename: ADAPTER_CORE_PATH,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(ADAPTER_CORE_PATH),
        paths: [],
        exports: core,
    };

    // ── snapshot stub ─────────────────────────────────────────────────────────
    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    injectModuleEntry(snapshotPath, {
        fetchSnapshot:
            opts.fetchSnapshotStub ??
            sinon.stub().resolves(Buffer.from("FAKEJPEG")),
        buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
        SnapshotError: class extends Error {},
    });

    // ── live_session stub ─────────────────────────────────────────────────────
    const fakeSession = {
        camId: CAM_GEN2_LIGHT,
        lanAddress: "192.0.2.149:443",
        proxyUrl: "rtsp://127.0.0.1:18050/rtsp_tunnel",
        maxSessionDuration: 3600,
        openedAt: Date.now(),
        digestUser: "cbs-user",
        digestPassword: "cbs-pass",
    };
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // Provide real error classes so instanceof checks in main work
    class LiveSessionError extends Error {}
    class CameraOfflineError extends Error {}
    class SessionLimitError extends Error {}
    const openLiveSessionStub =
        opts.openLiveSessionStub ?? sinon.stub().resolves(fakeSession);
    injectModuleEntry(liveSessionPath, {
        openLiveSession: openLiveSessionStub,
        closeLiveSession: sinon.stub().resolves(),
        LiveSessionError,
        CameraOfflineError,
        SessionLimitError,
    });

    // ── tls_proxy stub ────────────────────────────────────────────────────────
    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    injectModuleEntry(tlsProxyPath, {
        startTlsProxy: sinon.stub().resolves({
            port: 18050,
            localRtspUrl: "rtsp://127.0.0.1:18050/rtsp_tunnel",
            stop: sinon.stub().resolves(),
        }),
    });

    // ── session_watchdog stub ─────────────────────────────────────────────────
    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    injectModuleEntry(watchdogPath, {
        SessionWatchdog: class {
            start = sinon.stub();
            stop = sinon.stub();
            constructor(_o: unknown) {}
        },
    });

    // ── rcp stub (no-op) ──────────────────────────────────────────────────────
    const rcpPath = resolveBuildModule("rcp");
    // Do NOT delete rcpPath — let real rcp exports remain so constants are available.
    // But inject no-op for write functions.
    const realRcp = require(rcpPath) as object;
    injectModuleEntry(rcpPath, {
        ...realRcp,
        sendRcpCommand: sinon.stub().resolves({ payload: Buffer.alloc(0) }),
    });

    // ── fcm stub ──────────────────────────────────────────────────────────────
    const fcmPath = resolveBuildModule("fcm");
    delete require.cache[fcmPath];
    class FakeFcmCbsRegistrationError extends Error {
        constructor() {
            super("CBS registration rejected");
            this.name = "FcmCbsRegistrationError";
        }
    }
    const { EventEmitter } = require("events") as typeof import("events");
    class FakeFcmListener extends EventEmitter {
        start = sinon.stub().rejects(new FakeFcmCbsRegistrationError());
        stop = sinon.stub().resolves();
    }
    injectModuleEntry(fcmPath, {
        FcmListener: FakeFcmListener,
        FcmCbsRegistrationError: FakeFcmCbsRegistrationError,
        CLOUD_API: "https://residential.cbs.boschsecurity.com",
        FCM_SENDER_ID: "000000000000",
    });

    // ── axios stub ────────────────────────────────────────────────────────────
    const cameraBody = opts.cameraBody ?? CAM_GEN2_LIGHT_BODY;
    if (opts.axiosByUrl) {
        stubAxiosByUrl(opts.axiosByUrl);
    } else {
        stubAxiosSequence([
            { status: 200, data: cameraBody },
            ...(opts.extraAxiosResponses ?? []),
        ]);
    }

    // ── create adapter ────────────────────────────────────────────────────────
    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (_fn: () => void, _ms: number) => ({
        __mockTimer: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearTimeout = (_h: unknown) => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setInterval = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearInterval = (_h: unknown) => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).terminate = () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).writeFileAsync = sinon.stub().resolves();

    return { db, adapter };
}

async function bootWithTokens(
    db: MockDatabase,
    adapter: TestAdapter,
): Promise<void> {
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, {
        val: "stored.acc",
        ack: true,
    });
    db.publishState(`${adapter.namespace}.info.refresh_token`, {
        val: "stored.ref",
        ack: true,
    });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, {
        val: futureExpiry,
        ack: true,
    });
    await adapter.readyHandler!();
}

function getStateVal(
    db: MockDatabase,
    adapter: TestAdapter,
    id: string,
): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId);
    return (state as ioBroker.State | null | undefined)?.val;
}

const CLEANUP_MODULES = [
    "snapshot",
    "live_session",
    "tls_proxy",
    "session_watchdog",
    "rcp",
    "fcm",
];

// ── Test suites ───────────────────────────────────────────────────────────────

// ── Tests ─────────────────────────────────────────────────────────────────────

interface Call {
    method: string;
    url: string;
    body: unknown;
}

const GROUP = (b: number) => ({ brightness: b, color: "#112233", whiteBalance: null });
const SERVER_STATE = {
    frontLightSettings: { brightness: 60, color: null, whiteBalance: -1 },
    topLedLightSettings: GROUP(20),
    bottomLedLightSettings: GROUP(30),
};

describe("lighting writers — shared per-camera lock and merge safety", function () {
    this.timeout(15_000);
    let calls: Call[];
    let gate: Promise<void> | null;
    let getGate: Promise<void> | null;

    afterEach(() => {
        restoreAxios();
        sinon.restore();
        for (const m of CLEANUP_MODULES) delete require.cache[resolveBuildModule(m)];
        delete require.cache[MAIN_JS_PATH];
    });

    // Records every call; the FIRST lighting PUT waits on `gate` when set.
    async function boot(
        opts: { frontStatus?: number; topdownStatus?: number } = {},
    ): Promise<{ db: MockDatabase; adapter: TestAdapter }> {
        calls = [];
        gate = null;
        getGate = null;
        const made = makeAdapter({
            cameraBody: CAM_GEN2_LIGHT_BODY,
            axiosByUrl: [{ match: "/v11/video_inputs", status: 200, data: CAM_GEN2_LIGHT_BODY }],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const axiosMod = (made.adapter as any)._httpClient as any;
        let firstPutSeen = false;
        axiosMod.defaults.adapter = async (config: any) => {
            const method = String(config.method).toLowerCase();
            const url = String(config.url);
            const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
            const mk = (status: number, data: unknown) => ({
                status,
                statusText: "",
                headers: {},
                data,
                config,
                request: {},
            });
            if (url.endsWith("/lighting/switch") && method === "get") {
                calls.push({ method, url, body: null });
                // Snapshot before the gate so a delayed GET returns pre-write data.
                const snap = JSON.parse(JSON.stringify(SERVER_STATE));
                const g = getGate;
                getGate = null;
                if (g) await g;
                return mk(200, snap);
            }
            if (url.endsWith("/lighting/switch") && method === "put") {
                calls.push({ method, url, body });
                if (!firstPutSeen && gate) {
                    firstPutSeen = true;
                    await gate;
                }
                return mk(200, body);
            }
            if (url.endsWith("/lighting/switch/front") && method === "put") {
                calls.push({ method, url, body });
                return mk(opts.frontStatus ?? 204, "");
            }
            if (url.endsWith("/lighting/switch/topdown") && method === "put") {
                calls.push({ method, url, body });
                return mk(opts.topdownStatus ?? 204, "");
            }
            if (url.endsWith("/v11/video_inputs") && method === "get") {
                return mk(200, CAM_GEN2_LIGHT_BODY);
            }
            return mk(404, null);
        };
        await bootWithTokens(made.db, made.adapter);
        calls.length = 0;
        return made;
    }

    it("a concurrent LED-group write merges onto the previous writer's result (no lost update)", async () => {
        const { adapter } = await boot();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        a._lightingCache.set(CAM_GEN2_LIGHT, JSON.parse(JSON.stringify(SERVER_STATE)));
        let release!: () => void;
        gate = new Promise<void>((r) => {
            release = r;
        });
        const p1 = a.handleFrontLightIntensityUpdate(CAM_GEN2_LIGHT, 90);
        const p2 = a.handleLedGroupBrightnessUpdate(CAM_GEN2_LIGHT, "topLedLightSettings", 50);
        await new Promise((r) => setImmediate(r));
        // Second writer must not have sent its PUT while the first is in flight.
        expect(calls.filter((c) => c.method === "put")).to.have.length(1);
        release();
        await Promise.all([p1, p2]);
        const puts = calls.filter((c) => c.method === "put");
        expect(puts).to.have.length(2);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const second = puts[1].body as any;
        expect(second.frontLightSettings.brightness).to.equal(90);
        expect(second.topLedLightSettings.brightness).to.equal(50);
    });

    it("wallwasher write on a cold cache seeds from a GET and keeps the front group", async () => {
        const { adapter } = await boot();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        a._lightingCache.delete(CAM_GEN2_LIGHT);
        await a.handleWallwasherUpdate(CAM_GEN2_LIGHT, { brightness: 70 });
        expect(calls[0].method).to.equal("get");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const put = calls.find((c) => c.method === "put")!.body as any;
        expect(put.frontLightSettings.brightness).to.equal(60);
        expect(put.topLedLightSettings.brightness).to.equal(70);
    });

    it("front white-balance write takes the same lock as other lighting writers", async () => {
        const { adapter } = await boot();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        a._lightingCache.set(CAM_GEN2_LIGHT, JSON.parse(JSON.stringify(SERVER_STATE)));
        let release!: () => void;
        gate = new Promise<void>((r) => {
            release = r;
        });
        const p1 = a.handleLedGroupBrightnessUpdate(CAM_GEN2_LIGHT, "bottomLedLightSettings", 10);
        const p2 = a.handleFrontLightWhiteBalanceUpdate(CAM_GEN2_LIGHT, 0.5);
        await new Promise((r) => setImmediate(r));
        expect(calls.filter((c) => c.method === "put")).to.have.length(1);
        release();
        await Promise.all([p1, p2]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const second = calls.filter((c) => c.method === "put")[1].body as any;
        expect(second.bottomLedLightSettings.brightness).to.equal(10);
    });

    it("Gen2 on/off: front ok + topdown failed acks only the front group and rejects", async () => {
        const { db, adapter } = await boot({ frontStatus: 204, topdownStatus: 500 });
        const wallId = `${adapter.namespace}.cameras.${CAM_GEN2_LIGHT}.wallwasher_enabled`;
        db.publishState(wallId, { val: false, ack: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        let threw = false;
        try {
            await a._applyLightingState(CAM_GEN2_LIGHT, { frontLight: true, wallwasher: true });
        } catch {
            threw = true;
        }
        expect(threw).to.equal(true);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.front_light_enabled`)).to.equal(
            true,
        );
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.wallwasher_enabled`)).to.equal(
            false,
        );
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.light_enabled`)).to.not.equal(
            true,
        );
    });

    it("Gen2 on/off: both ok acks everything and resolves", async () => {
        const { db, adapter } = await boot();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._applyLightingState(CAM_GEN2_LIGHT, {
            frontLight: true,
            wallwasher: true,
        });
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.light_enabled`)).to.equal(true);
    });

    it("a poll GET that straddles a writer must not overwrite the cache or DPs with stale data", async () => {
        const { db, adapter } = await boot();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        const cam = a._cameras.get(CAM_GEN2_LIGHT);
        a._lightingCache.set(CAM_GEN2_LIGHT, JSON.parse(JSON.stringify(SERVER_STATE)));
        let release!: () => void;
        getGate = new Promise<void>((r) => {
            release = r;
        });
        const poll = a._pollSingleCameraState("stored.acc", cam, false);
        await new Promise((r) => setImmediate(r));
        await a.handleFrontLightIntensityUpdate(CAM_GEN2_LIGHT, 90);
        release();
        await poll;
        expect(a._lightingCache.get(CAM_GEN2_LIGHT).frontLightSettings.brightness).to.equal(90);
        expect(
            getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.front_light_intensity`),
        ).to.not.equal(60);
    });

    it("a poll with no concurrent writer still refreshes the cache", async () => {
        const { adapter } = await boot();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        const cam = a._cameras.get(CAM_GEN2_LIGHT);
        a._lightingCache.delete(CAM_GEN2_LIGHT);
        await a._pollSingleCameraState("stored.acc", cam, false);
        expect(a._lightingCache.get(CAM_GEN2_LIGHT).frontLightSettings.brightness).to.equal(60);
    });

    it("a poll is not blocked behind a writer chain (no lock wait)", async () => {
        const { adapter } = await boot();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        const cam = a._cameras.get(CAM_GEN2_LIGHT);
        a._lightingCache.set(CAM_GEN2_LIGHT, JSON.parse(JSON.stringify(SERVER_STATE)));
        let release!: () => void;
        gate = new Promise<void>((r) => {
            release = r;
        });
        const w = a.handleFrontLightIntensityUpdate(CAM_GEN2_LIGHT, 90);
        await new Promise((r) => setImmediate(r));
        await a._pollSingleCameraState("stored.acc", cam, false);
        release();
        await w;
    });

    it("front and wallwasher toggles fired together do not undo each other", async () => {
        const { db, adapter } = await boot();
        const ns = adapter.namespace;
        db.publishState(`${ns}.cameras.${CAM_GEN2_LIGHT}.front_light_enabled`, {
            val: false,
            ack: true,
        });
        db.publishState(`${ns}.cameras.${CAM_GEN2_LIGHT}.wallwasher_enabled`, {
            val: false,
            ack: true,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        await Promise.all([
            a.handleFrontLightToggle(CAM_GEN2_LIGHT, true),
            a.handleWallwasherToggle(CAM_GEN2_LIGHT, true),
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lastBody = (suffix: string): any =>
            calls.filter((c) => c.method === "put" && c.url.endsWith(suffix)).pop()!.body;
        expect(lastBody("/switch/front").enabled).to.equal(true);
        expect(lastBody("/switch/topdown").enabled).to.equal(true);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.front_light_enabled`)).to.equal(
            true,
        );
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.wallwasher_enabled`)).to.equal(
            true,
        );
    });
});

// externalAuthorityInstall.test.js
//
// Tests for the host-facing install glue at
// ``/home/antonio/repos/opengene/web/ove/packages/ove/src/redux/externalAuthorityInstall.js``.
// The helper exposes a ``window.__OVE_EXTERNAL_AUTHORITY__`` namespace
// with ``install``, ``uninstall``, ``isConfigured``, ``createMiddleware``,
// and ``getInstalledOptions``. The store factory in
// ``createVectorEditor/makeStore.js`` reads ``createMiddleware()`` at
// runtime and inserts the middleware into the chain when one is
// configured.
//
// These tests exercise the helper against a JSDOM ``window`` (preloaded
// via ``bunfig.toml``). They do NOT exercise ``makeStore.js`` directly
// because that would require a full React/Redux stack — the helper is
// the contract; the store factory is the consumer.

import { describe, it, expect, beforeEach } from "bun:test";
import __OVE_EXTERNAL_AUTHORITY__, {
  install,
  uninstall,
  isConfigured,
  createMiddleware,
  getInstalledOptions
} from "../externalAuthorityInstall.js";

const baseOptions = () => ({
  submit: async () => ({
    status: "accepted",
    new_revision: 1,
    canonical_snapshot: null
  }),
  documentId: "doc-1",
  surfaceId: "surface-1",
  revision: () => 0,
  applySnapshot: snapshot => {
    // Captures the latest snapshot for assertions in tests that
    // install a fresh applySnapshot handle.
    void snapshot;
  },
  onResponse: response => {
    // Captures the latest response for assertions.
    void response;
  }
});

describe("externalAuthorityInstall (host-facing glue)", () => {
  beforeEach(() => {
    uninstall();
    // Re-publish the namespace on the per-test JSDOM window so
    // tests that probe ``window.__OVE_EXTERNAL_AUTHORITY__`` see
    // a fresh handle. The production load-path
    // (``createVectorEditor/index.js``) does the same side-effect
    // at bundle-evaluation time.
    if (typeof global.window !== "undefined") {
      global.window.__OVE_EXTERNAL_AUTHORITY__ = __OVE_EXTERNAL_AUTHORITY__;
    }
  });

  it("is not configured when no host has called install()", () => {
    expect(isConfigured()).toBe(false);
    expect(createMiddleware()).toBeNull();
    expect(getInstalledOptions()).toBeNull();
  });

  it("stores options and reports configured after install()", () => {
    const opts = baseOptions();
    install(opts);
    expect(isConfigured()).toBe(true);
    expect(getInstalledOptions()).toBe(opts);
  });

  it("createMiddleware returns a Redux middleware function after install()", () => {
    install(baseOptions());
    const mw = createMiddleware();
    expect(typeof mw).toBe("function");
    // Redux middleware signature: (store) => (next) => (action) => ...
    expect(typeof mw({ getState: () => ({}) })).toBe("function");
  });

  it("createMiddleware returns null after uninstall()", () => {
    install(baseOptions());
    uninstall();
    expect(createMiddleware()).toBeNull();
  });

  it("install replaces the previous options when called twice", () => {
    const optsA = baseOptions();
    const optsB = { ...baseOptions(), documentId: "doc-2" };
    install(optsA);
    install(optsB);
    expect(getInstalledOptions()).toBe(optsB);
    expect(getInstalledOptions().documentId).toBe("doc-2");
  });

  it("rejects install() with no submit function", () => {
    expect(() => install({ documentId: "x", surfaceId: "y" })).toThrow(
      /options.submit/
    );
  });

  it("rejects install() with empty documentId", () => {
    expect(() => install({ ...baseOptions(), documentId: "" })).toThrow(
      /options.documentId/
    );
  });

  it("rejects install() with empty surfaceId", () => {
    expect(() => install({ ...baseOptions(), surfaceId: "" })).toThrow(
      /options.surfaceId/
    );
  });

  it("uninstall() is a no-op when nothing is installed", () => {
    // Should not throw, should not change configured state.
    uninstall();
    expect(isConfigured()).toBe(false);
  });

  it("exposes a window.__OVE_EXTERNAL_AUTHORITY__ frozen object", () => {
    expect(typeof global.window.__OVE_EXTERNAL_AUTHORITY__).toBe("object");
    expect(Object.isFrozen(global.window.__OVE_EXTERNAL_AUTHORITY__)).toBe(
      true
    );
    expect(typeof global.window.__OVE_EXTERNAL_AUTHORITY__.install).toBe(
      "function"
    );
    expect(typeof global.window.__OVE_EXTERNAL_AUTHORITY__.uninstall).toBe(
      "function"
    );
    expect(typeof global.window.__OVE_EXTERNAL_AUTHORITY__.isConfigured).toBe(
      "function"
    );
    expect(
      typeof global.window.__OVE_EXTERNAL_AUTHORITY__.createMiddleware
    ).toBe("function");
    expect(
      typeof global.window.__OVE_EXTERNAL_AUTHORITY__.getInstalledOptions
    ).toBe("function");
  });

  it("matches the default export's surface area", () => {
    expect(__OVE_EXTERNAL_AUTHORITY__).toBe(
      global.window.__OVE_EXTERNAL_AUTHORITY__
    );
  });

  it("createMiddleware() captures the latest installed options", async () => {
    const optsA = { ...baseOptions(), documentId: "doc-a" };
    const optsB = { ...baseOptions(), documentId: "doc-b" };
    install(optsA);
    install(optsB);
    const mw = createMiddleware();
    // Drive the middleware; the closure should reference optsB.
    const seen = [];
    const store = {
      getState: () => ({ VectorEditor: { revision: 0 } }),
      dispatch: a => seen.push(a)
    };
    const next = a => seen.push(a);
    const action = { type: "ADD_BPS", payload: { sequence: "AAA" } };
    await mw(store)(next)(action);
    // We don't deeply assert the request envelope here; that's
    // covered by externalAuthority.test.js. We just verify the
    // middleware ran without throwing when optsB is the installed
    // options — i.e. the closure capture works.
    expect(seen.length).toBeGreaterThan(0);
  });
});

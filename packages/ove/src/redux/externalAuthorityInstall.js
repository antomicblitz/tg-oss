// externalAuthorityInstall.js
//
// Host-facing glue that lets an embedding page (e.g. OpenGene's
// `web/ove-host/src/index.html`) wire the OVE → external-authority
// Redux middleware into a ``createVectorEditor`` store. The helper
// exposes a single ``window.__OVE_EXTERNAL_AUTHORITY__`` namespace so
// the page does not need to import any OVE source directly.
//
// Workflow:
//
//   1. The host page (after QWebChannel is ready and ``submitTransaction``
//      is wired up) calls ``window.__OVE_EXTERNAL_AUTHORITY__.install``
//      with the submit / revision-getter / applySnapshot / onResponse
//      callbacks. Each callback is captured into a module-scoped slot.
//
//   2. The next call to ``createVectorEditor(...)`` finds the populated
//      slot and inserts ``createExternalAuthorityMiddleware`` into the
//      store's middleware chain. ``makeStore.js`` reads the slot via
//      ``window.__OVE_EXTERNAL_AUTHORITY__.createMiddleware()`` — it
//      only ever calls into the helper; it never reaches back into
//      ``window.__OVE_EXTERNAL_AUTHORITY__`` directly. This keeps the
//      embedding contract narrow.
//
//   3. The host page may call ``uninstall()`` to clear the slot, e.g.
//      when navigating away. The helper exposes ``isConfigured()``
//      so the store can ask before allocating the middleware.
//
// Security / CSP note: this helper is part of the OVE UMD bundle, which
// is loaded via ``<script src="index.umd.js">`` (same-origin, no
// inline). The ``window.__OVE_EXTERNAL_AUTHORITY__`` namespace is
// consumed by OVE's own ``makeStore.js``; the host page never imports
// OVE source. The strict CSP in OpenGene's host page
// (``script-src 'self'``) keeps this surface unspoofable from a remote
// origin.

import { createExternalAuthorityMiddleware } from "./externalAuthority.js";

let configuredOptions = null;
let activeUninstall = null;

function isConfigured() {
  return configuredOptions !== null;
}

function createMiddleware() {
  if (!configuredOptions) {
    return null;
  }
  // Capture the latest options in the closure; ``install()`` may be
  // called more than once in some test scenarios.
  const options = configuredOptions;
  return createExternalAuthorityMiddleware(options);
}

function install(options) {
  // Validate the payload first so a malformed re-install cannot
  // silently succeed by replacing valid options with garbage.
  if (!options || typeof options.submit !== "function") {
    throw new Error(
      "__OVE_EXTERNAL_AUTHORITY__.install requires options.submit (function)"
    );
  }
  if (typeof options.documentId !== "string" || options.documentId === "") {
    throw new Error(
      "__OVE_EXTERNAL_AUTHORITY__.install requires options.documentId (string)"
    );
  }
  if (typeof options.surfaceId !== "string" || options.surfaceId === "") {
    throw new Error(
      "__OVE_EXTERNAL_AUTHORITY__.install requires options.surfaceId (string)"
    );
  }
  // Each install() allocates a fresh activeUninstall closure. The
  // previous closure (if any) still works for the previous options
  // it captured, but a re-install always hands the host a fresh
  // handle that targets the latest options — that handle is the
  // one the host should keep. Stale handles (from older installs)
  // become no-ops because their captured ``options`` no longer
  // matches ``configuredOptions``.
  const myUninstall = () => {
    if (configuredOptions === options) {
      configuredOptions = null;
      if (activeUninstall === myUninstall) {
        activeUninstall = null;
      }
    }
  };
  configuredOptions = options;
  activeUninstall = myUninstall;
  return myUninstall;
}

function uninstall() {
  if (typeof activeUninstall === "function") {
    activeUninstall();
  }
}

function getInstalledOptions() {
  return configuredOptions;
}

const __OVE_EXTERNAL_AUTHORITY__ = Object.freeze({
  install,
  uninstall,
  isConfigured,
  createMiddleware,
  getInstalledOptions
});

// Note: the ``window.__OVE_EXTERNAL_AUTHORITY__`` side-effect is
// applied by ``createVectorEditor/index.js`` (which is the canonical
// load-path for the UMD bundle), not here. Doing the assignment in
// this module would freeze the namespace to the first ``window``
// object the module saw at import time, which breaks under JSDOM's
// per-test reset pattern and forces consumers to dance around
// module-cached state.

export default __OVE_EXTERNAL_AUTHORITY__;
export {
  install,
  uninstall,
  isConfigured,
  createMiddleware,
  getInstalledOptions
};

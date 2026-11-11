//optionally connect to the redux store
import { createStore, combineReducers, applyMiddleware, compose } from "redux";
import VectorEditor, { vectorEditorMiddleware } from "../redux";
import thunk from "redux-thunk";
import { reducer as form } from "redux-form";

// One-shot warning so a misordered host page (``createVectorEditor``
// called before ``install``) doesn't silently bypass the slice 1a
// external-authority middleware. The warning fires once per page
// load — repeating it on every ``makeStore`` call would flood the
// console when OVE creates and destroys stores internally.
//
// NOTE on the install-namespace lookup: we read
// ``window.__OVE_EXTERNAL_AUTHORITY__`` *inside* ``makeStore`` rather
// than at module top. The previous module-eval capture broke
// refactors that move the ``createVectorEditor/index.js``
// side-effect that publishes the namespace — the module would
// capture ``undefined`` and the middleware would silently never
// wire. Reading at call-site is a one-property-access penalty per
// store creation and is robust to load-order changes.
let warnedAboutMissingAuthority = false;

const makeStore = () => {
  const composeEnhancer =
    (window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ &&
      window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__({
        name: "createVectorEditor",
        latency: 1000,
        // serialize: {
        //   replacer: (key, value) => {
        //   }
        // },
        actionsDenylist: []
      })) ||
    compose;

  // Read the install namespace lazily so the lookup is robust
  // to UMD-wrapper side-effect ordering. ``createMiddleware()``
  // returns ``null`` when no host has called ``install()``.
  const externalAuthority = window.__OVE_EXTERNAL_AUTHORITY__;

  // Build the middleware chain every time ``makeStore`` runs so a
  // later ``install()`` (e.g. via test teardown) is picked up by the
  // next store creation. This keeps the host-page lifecycle simple:
  // it can install the authority AFTER the page is rendered and
  // before any subsequent ``createVectorEditor`` call.
  // Reason: the external authority must sit *before* the local undo
  // middleware. `vectorEditorMiddleware` applies VE_UNDO / VE_REDO from its
  // own stack and records ADD_TO_UNDO_STACK after every sequenceData change.
  // When Python owns the canonical document and the only undo stack, the
  // authority has to intercept the mutation first: it submits the request,
  // applies the canonical snapshot, and swallows VE_UNDO / VE_REDO so the
  // local stack never becomes a second undo authority. Standalone OVE (no
  // install) keeps the original `[thunk, vectorEditorMiddleware]` chain.
  const middlewares = [thunk];
  if (
    externalAuthority &&
    typeof externalAuthority.createMiddleware === "function"
  ) {
    const externalMw = externalAuthority.createMiddleware();
    if (externalMw) {
      middlewares.push(externalMw);
    } else if (
      typeof externalAuthority.isConfigured === "function" &&
      !externalAuthority.isConfigured() &&
      !warnedAboutMissingAuthority
    ) {
      // The host page is present (the install helper is on window)
      // but no ``install()`` call has been made yet. The store will
      // run standalone; every mutation will apply locally and never
      // reach the host's authority. Surface this as a warning so
      // the host-page developer can fix the order.
      warnedAboutMissingAuthority = true;
      console.warn(
        "[OVE] window.__OVE_EXTERNAL_AUTHORITY__ is exposed but install() " +
          "has not been called. Mutating Redux actions will apply locally " +
          "without bouncing through the host's authority. Call " +
          "window.__OVE_EXTERNAL_AUTHORITY__.install({...}) BEFORE " +
          "createVectorEditor(...) to enable the slice 1a middleware."
      );
    }
  }
  middlewares.push(vectorEditorMiddleware);

  const store = createStore(
    combineReducers({
      form,
      VectorEditor: VectorEditor()
    }),
    undefined,
    composeEnhancer(
      applyMiddleware(...middlewares) //your store should be redux-thunk connected for the VectorEditor component to work
    )
  );
  return store;
};

export default makeStore;

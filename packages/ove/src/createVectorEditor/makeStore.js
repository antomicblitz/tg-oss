//optionally connect to the redux store
import { createStore, combineReducers, applyMiddleware, compose } from "redux";
import VectorEditor, { vectorEditorMiddleware } from "../redux";
import thunk from "redux-thunk";
import { reducer as form } from "redux-form";

// Read the external-authority middleware factory from the global
// install namespace. ``createMiddleware()`` returns ``null`` when no
// host has called ``install()``, in which case the chain stays as
// upstream OVE (thunk + vectorEditorMiddleware) and the store runs
// standalone. ``isConfigured()`` is also exported so tests can assert
// the install helper without touching the middleware itself.
const externalAuthority = window.__OVE_EXTERNAL_AUTHORITY__;

// One-shot warning so a misordered host page (``createVectorEditor``
// called before ``install``) doesn't silently bypass the slice 1a
// external-authority middleware. The warning fires once per page
// load — repeating it on every ``makeStore`` call would flood the
// console when OVE creates and destroys stores internally.
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

  // Build the middleware chain every time ``makeStore`` runs so a
  // later ``install()`` (e.g. via test teardown) is picked up by the
  // next store creation. This keeps the host-page lifecycle simple:
  // it can install the authority AFTER the page is rendered and
  // before any subsequent ``createVectorEditor`` call.
  const middlewares = [thunk, vectorEditorMiddleware];
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

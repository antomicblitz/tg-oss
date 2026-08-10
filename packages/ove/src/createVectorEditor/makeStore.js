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
  // later ``install()`` (e.g. via test teardown) is picked up by
  // the next store creation. This keeps the host-page lifecycle
  // simple: it can install the authority AFTER the page is rendered
  // and before any subsequent ``createVectorEditor`` call.
  const middlewares = [thunk, vectorEditorMiddleware];
  if (
    externalAuthority &&
    typeof externalAuthority.createMiddleware === "function"
  ) {
    const externalMw = externalAuthority.createMiddleware();
    if (externalMw) middlewares.push(externalMw);
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

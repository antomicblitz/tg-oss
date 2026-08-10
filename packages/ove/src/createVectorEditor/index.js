import React from "react";
import { Provider } from "react-redux";
import makeStore from "./makeStore";
import { render, unmountComponentAtNode } from "react-dom";

import Editor from "../Editor";
import updateEditor from "../updateEditor";
import addAlignment from "../addAlignment";
import AlignmentView from "../AlignmentView";
import sizeMe from "react-sizeme";
import VersionHistoryView from "../VersionHistoryView";
import __OVE_EXTERNAL_AUTHORITY__ from "../redux/externalAuthorityInstall.js";

let store;

function StandaloneEditor(props) {
  if (!store) {
    store = makeStore();
  }
  return (
    <Provider store={store}>
      <Editor {...props} />
    </Provider>
  );
}

function StandaloneAlignment(props) {
  if (!store) {
    store = makeStore();
  }
  return (
    <Provider store={store}>
      <AlignmentView
        {...{ ...props, dimensions: { width: props.size.width } }}
      />
    </Provider>
  );
}

function StandaloneVersionHistoryView(props) {
  if (!store) {
    store = makeStore();
  }
  return (
    <Provider store={store}>
      <VersionHistoryView {...{ ...props }} />
    </Provider>
  );
}

export default function createVectorEditor(
  _node,
  { editorName = "StandaloneEditor", ...rest } = {}
) {
  if (!store) {
    store = makeStore();
  }
  let node;

  if (_node === "createDomNodeForMe") {
    node = document.createElement("div");
    node.className = "ove-created-div";
    document.body.appendChild(node);
  } else {
    node = _node;
  }
  const editor = {};
  editor.renderResponse = render(
    <StandaloneEditor {...{ editorName, ...rest }} />,
    node
  );
  editor.close = () => {
    unmountComponentAtNode(node);
    node.remove();
  };
  editor.updateEditor = values => {
    updateEditor(store, editorName, values);
  };
  editor.addAlignment = values => {
    addAlignment(store, values);
  };
  editor.getState = () => {
    return store.getState().VectorEditor[editorName];
  };
  // Expose ``dispatch`` so the embedding host page (e.g.
  // ``web/ove-host/src/host.js``) can drive OVE mutations through
  // the full middleware chain. The slice 1a external-authority
  // middleware lives in the chain between ``dispatch`` and the
  // reducer; calling ``editor.dispatch`` from the host page is
  // what actually exercises the middleware end-to-end.
  // ``updateEditor`` skips the middleware on purpose (it dispatches
  // ``VECTOR_EDITOR_UPDATE`` which is not in the middleware's
  // mutation list), so the host page still uses
  // ``updateEditor`` for setting the initial snapshot.
  editor.dispatch = action => {
    return store.dispatch(action);
  };

  return editor;
}

export function createVersionHistoryView(
  node,
  { editorName = "StandaloneVersionHistoryView", ...rest } = {}
) {
  if (!store) {
    store = makeStore();
  }
  const editor = {};
  editor.renderResponse = render(
    <StandaloneVersionHistoryView {...{ editorName, ...rest }} />,
    node
  );

  editor.updateEditor = values => {
    updateEditor(store, editorName, values);
  };
  editor.getState = () => {
    return store.getState().VectorEditor["StandaloneVersionHistoryView"];
  };

  return editor;
}

const SizedStandaloneAlignment = sizeMe()(StandaloneAlignment);
export function createAlignmentView(node, props = {}) {
  if (!store) {
    store = makeStore();
  }
  const editor = {};
  editor.renderResponse = render(<SizedStandaloneAlignment {...props} />, node);

  editor.updateAlignment = values => {
    addAlignment(store, values);
  };
  editor.updateAlignment(props);
  editor.getState = () => {
    if (!props.id) {
      throw new Error(
        'Please pass an id when using createAlignmentView. eg createAlignmentView(myDiv, {id: "someUniqueId"})'
      );
    }
    return store.getState().VectorEditor.__allEditorsOptions.alignments[
      props.id
    ];
  };
  return editor;
}

window.createVectorEditor = createVectorEditor;
window.createAlignmentView = createAlignmentView;
window.createVersionHistoryView = createVersionHistoryView;
// External-authority glue (slice 1a + slice 14 host-page wire-up).
// The host page calls ``window.__OVE_EXTERNAL_AUTHORITY__.install({...})``
// after the QWebChannel handshake; ``makeStore.js`` reads
// ``createMiddleware()`` on every store creation and inserts the
// middleware into the chain when one is configured. Standalone OVE
// (no install call) still works because ``isConfigured()`` returns
// false and ``makeStore.js`` skips the slot.
window.__OVE_EXTERNAL_AUTHORITY__ = __OVE_EXTERNAL_AUTHORITY__;

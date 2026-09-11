'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LgtDetectionState = api;
})(globalThis, function () {
  const MAX_FRAMES = 32;
  const LAYERS = ['mfe', 'iframe', 'nodejs'];
  function create(store) {
    function empty() { return { frames: {}, generation: crypto.randomUUID() }; }
    function newFrame() { return { generation: crypto.randomUUID(), runtime: {}, network: {}, document: null }; }
    function edit(tabId, change, create = true) {
      return store.update('detection', tabId, value => {
        if (!value && !create) return null;
        const state = value || empty();
        change(state);
        const ids = Object.keys(state.frames);
        while (ids.length > MAX_FRAMES) {
          const index = ids.findIndex(id => id !== '0');
          delete state.frames[ids.splice(index, 1)[0]];
        }
        return state;
      });
    }
    function frameFor(state, details) {
      if (details.documentId && state.retiredDocuments?.includes(details.documentId)) return null;
      const id = details.frameId || 0;
      const frame = state.frames[id] ||= newFrame();
      if (details.documentId && frame.retiredDocuments?.includes(details.documentId)) return null;
      if (details.documentId && frame.documentId && details.documentId !== frame.documentId) return null;
      return frame;
    }
    function navigate(details) {
      return edit(details.tabId, state => {
        const previous = state.frames[details.frameId];
        if (details.frameId === 0) {
          state.retiredDocuments = [...(state.retiredDocuments || []), ...Object.values(state.frames).map(frame => frame.documentId)].filter(Boolean).slice(-128);
          state.frames = {}; state.generation = crypto.randomUUID();
        }
        const next = newFrame();
        next.retiredDocuments = [...(previous?.retiredDocuments || []), previous?.documentId].filter(Boolean).slice(-4);
        state.frames[details.frameId] = next;
      });
    }
    function committed(details, document) {
      return edit(details.tabId, state => {
        let frame = state.frames[details.frameId] ||= newFrame();
        if (frame.documentId && details.documentId && frame.documentId !== details.documentId) {
          frame = state.frames[details.frameId] = newFrame();
        }
        frame.documentId = details.documentId || null;
        frame.document = document;
      });
    }
    async function observe(details, layer, observation) {
      let token = null;
      await edit(details.tabId, state => {
        const frame = frameFor(state, details);
        if (!frame || !LAYERS.includes(layer)) return;
        token = { tab: state.generation, frame: frame.generation, observation: crypto.randomUUID() };
        frame.network[layer] = { ...observation, observationId: token.observation };
      });
      return token;
    }
    function enrich(details, layer, token, change) {
      if (!token) return Promise.resolve();
      return edit(details.tabId, state => {
        const frame = state.frames[details.frameId || 0];
        const current = frame?.network[layer];
        if (state.generation !== token.tab || frame?.generation !== token.frame || current?.observationId !== token.observation) return;
        change(current);
      }, false);
    }
    function markers(sender, markers) {
      return edit(sender.tab.id, state => {
        const frame = frameFor(state, sender);
        if (!frame) return;
        // sender.documentId comes from Chrome, never from a page's postMessage.
        if (sender.documentId && !frame.documentId) frame.documentId = sender.documentId;
        for (const marker of (Array.isArray(markers) ? markers : []).slice(0, 3)) {
          if (!LAYERS.includes(marker?.layer)) continue;
          const clean = { ts: Date.now(), layer: marker.layer };
          for (const key of ['brandId', 'brandName', 'version', 'environment', 'appHash', 'versionSource', 'environmentSource', 'device']) {
            if (typeof marker[key] === 'string') clean[key] = marker[key].slice(0, 512);
          }
          frame.runtime[marker.layer] = clean;
        }
      });
    }
    function header(details, value) {
      return edit(details.tabId, state => {
        const frame = frameFor(state, details);
        if (frame?.network.iframe) frame.network.iframe.headerVersion = String(value).slice(0, 128);
      });
    }
    async function snapshot(tabId) {
      const state = await store.serialize(store.keyFor('detection', tabId), () => store.read('detection', tabId));
      const result = { runtimeByFrame: {}, networkByFrame: {}, docByFrame: {} };
      for (const [id, frame] of Object.entries(state?.frames || {})) {
        result.runtimeByFrame[id] = frame.runtime;
        result.networkByFrame[id] = frame.network;
        if (frame.document) result.docByFrame[id] = frame.document;
      }
      return result;
    }
    async function current(details, layer) {
      const state = await store.serialize(store.keyFor('detection', details.tabId), () => store.read('detection', details.tabId));
      const frame = state?.frames[details.frameId || 0];
      const observation = frame?.network[layer];
      if (!observation) return null;
      return { observation, token: { tab: state.generation, frame: frame.generation, observation: observation.observationId } };
    }
    return { navigate, committed, observe, enrich, markers, header, snapshot, current };
  }
  return { create };
});

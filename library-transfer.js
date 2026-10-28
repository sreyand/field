/* A versioned, validated handoff from the browser catalogue to the desktop app. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./library-model.js') : root.FieldModel);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FieldTransfer = api;
})(typeof globalThis === 'object' ? globalThis : this, function (modelAPI) {
  'use strict';
  const { LibraryModel } = modelAPI;
  const limit = 64 * 1024 * 1024;
  function checkSize(text) {
    if (new TextEncoder().encode(text).byteLength > limit) throw new Error('This library exceeds the 64 MB import limit for this alpha.');
  }
  function encode(snapshot) {
    const text = JSON.stringify({ format: 'FIELD.library', version: 1, exportedAt: new Date().toISOString(), snapshot: new LibraryModel(snapshot).snapshot() });
    checkSize(text);
    return text;
  }
  function decode(text) {
    if (typeof text !== 'string') throw new Error('Choose a FIELD library export.');
    checkSize(text);
    let archive;
    try { archive = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('This file is not valid JSON.'); }
    const snapshot = archive?.snapshot;
    if (archive?.format !== 'FIELD.library' || archive.version !== 1 || !snapshot || snapshot.version !== 1 ||
        ['fields', 'items', 'memberships', 'connections'].some(key => !Array.isArray(snapshot[key]))) {
      throw new Error('Choose a FIELD library export with a supported format.');
    }
    return new LibraryModel(snapshot).snapshot();
  }
  return { encode, decode, maxBytes: limit };
});

/* Canonical library records and field memberships. No browser or storage dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FieldModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const ITEM_KINDS = new Set(['link', 'file', 'note', 'drawing']);
  const NATIVE_STATUSES = new Set(['available', 'missing', 'unavailable', 'inaccessible', 'unsupported', 'replaced', 'unresolved']);
  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new Error(`${label} must be a plain object.`);
    }
    return value;
  }

  function dataCopy(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(dataCopy);
    plainObject(value, 'Record data');
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsupported record property.');
      return [key, dataCopy(entry)];
    }));
  }

  function requiredText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
    return value.trim();
  }

  function identifier(value, label = 'ID') {
    const id = requiredText(value, label);
    if (id !== value) throw new Error(`${label} cannot contain surrounding whitespace.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`${label} contains unsupported characters.`);
    return id;
  }

  function normalizedURL(value) {
    let url;
    try { url = new URL(requiredText(value, 'URL')); }
    catch { throw new Error('Enter a valid absolute URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https URL.');
    return url.href;
  }

  function normalizedWindowsPath(value) {
    let path = requiredText(value, 'File path').replace(/\//g, '\\');
    if (/^\\\\\?\\UNC\\/i.test(path)) path = '\\\\' + path.slice(8);
    else if (/^\\\\\?\\[a-z]:\\/i.test(path)) path = path.slice(4);

    let root;
    let segments;
    if (/^[a-z]:\\/i.test(path)) {
      root = path.slice(0, 2).toLowerCase();
      segments = path.slice(3).split('\\');
    } else if (/^\\\\[^\\]+\\[^\\]+/.test(path) && !/^\\\\[.?]\\/.test(path)) {
      const all = path.slice(2).split('\\');
      const server = all.shift();
      const share = all.shift();
      if (!server || !share || ['.', '..'].includes(server) || ['.', '..'].includes(share)) throw new Error('Enter an absolute Windows path.');
      root = `\\\\${server}\\${share}`.toLowerCase();
      segments = all;
    } else {
      throw new Error('Enter an absolute Windows path.');
    }

    const parts = [];
    for (const part of segments) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw new Error('File path cannot go above its root.');
        parts.pop();
      } else parts.push(part.toLowerCase());
    }
    return root + '\\' + parts.join('\\');
  }

  function identityKey(record) {
    plainObject(record, 'Item');
    if (record.kind === 'link') return `link:${normalizedURL(record.url)}`;
    if (record.kind === 'file' && record.native !== undefined && record.native !== null) {
      plainObject(record.native, 'Native file reference');
      if (record.native.identity !== null && record.native.identity !== undefined) {
        const identity = nativeIdentity(record.native.identity);
        return `native:${identity.volumeSerial.toLowerCase()}:${identity.fileId.toLowerCase()}:${BigInt(identity.creationTime).toString()}`;
      }
    }
    if (record.kind === 'file' && typeof record.path === 'string' && record.path.trim()) {
      return `file:${normalizedWindowsPath(record.path)}`;
    }
    return null;
  }

  function nativeIdentity(source) {
    plainObject(source, 'Native file identity');
    if (typeof source.volumeSerial !== 'string' || !/^[a-f0-9]{16}$/i.test(source.volumeSerial)) {
      throw new Error('Native volume serial must contain 16 hex digits.');
    }
    if (typeof source.fileId !== 'string' || !/^[a-f0-9]{32}$/i.test(source.fileId)) {
      throw new Error('Native file ID must contain 32 hex digits.');
    }
    if (typeof source.creationTime !== 'string' || !/^\d{1,20}$/.test(source.creationTime) || BigInt(source.creationTime) > 18446744073709551615n) {
      throw new Error('Native creation time must be an unsigned 64-bit decimal string.');
    }
    const volumePath = requiredText(source.volumePath, 'Native volume path');
    if (volumePath.includes('\0')) throw new Error('Invalid native volume path.');
    // A host may retain a volume GUID path so a drive-letter change does not hide the volume.
    const guidVolume = /^\\\\\?\\Volume\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}\\$/i.test(volumePath);
    if (!guidVolume) normalizedWindowsPath(volumePath);
    return source;
  }

  function nativeReference(source) {
    plainObject(source, 'Native file reference');
    const native = dataCopy(source);
    native.referenceId = identifier(native.referenceId, 'Native reference ID');
    if (!owns(native, 'identity')) throw new Error('Native identity must be present or null.');
    if (native.identity !== null) nativeIdentity(native.identity);
    native.path = requiredText(native.path, 'Native file path');
    if (native.path.includes('\0')) throw new Error('Invalid native file path.');
    normalizedWindowsPath(native.path);
    native.fileName = requiredText(native.fileName, 'Native file name');
    if (/[\\/\0]/.test(native.fileName)) throw new Error('Native file name cannot contain path separators.');
    if (!NATIVE_STATUSES.has(native.status)) throw new Error('Unsupported native file status.');
    if (typeof native.recoverable !== 'boolean') throw new Error('Native recoverable must be a boolean.');
    if (native.size !== undefined && native.size !== null && (!Number.isSafeInteger(native.size) || native.size < 0)) {
      throw new Error('Invalid native file size.');
    }
    if (native.modifiedUtc !== undefined && native.modifiedUtc !== null &&
        (typeof native.modifiedUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|\+00:00)$/i.test(native.modifiedUtc) || !Number.isFinite(Date.parse(native.modifiedUtc)))) {
      throw new Error('Native modified time must be a UTC timestamp or null.');
    }
    if (native.message !== undefined && native.message !== null && typeof native.message !== 'string') {
      throw new Error('Native file message must be text or null.');
    }
    return native;
  }

  function itemRecord(source) {
    plainObject(source, 'Item');
    const { fields: ignoredFields, ...sourceRecord } = source;
    const record = dataCopy(sourceRecord);
    record.id = identifier(record.id, 'Item ID');
    if (!ITEM_KINDS.has(record.kind)) throw new Error('Unsupported item kind.');
    if (record.kind !== 'file' && record.native !== undefined && record.native !== null) throw new Error('Only files can have native file references.');
    record.title = requiredText(record.title, 'Item name');
    if (record.kind === 'link') record.url = normalizedURL(record.url);
    if (record.kind === 'note') record.body = requiredText(record.body, 'Note');
    if (record.kind === 'drawing' && (typeof record.drawing !== 'string' || !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(record.drawing))) {
      throw new Error('Drawing must be a PNG data URL.');
    }
    if (record.kind === 'file') {
      if (record.path !== undefined && typeof record.path !== 'string') throw new Error('File path must be text.');
      record.path = record.path?.trim() || '';
      if (record.path) normalizedWindowsPath(record.path);
      if (record.native !== undefined && record.native !== null) {
        record.native = nativeReference(record.native);
        if (normalizedWindowsPath(record.path) !== normalizedWindowsPath(record.native.path)) {
          throw new Error('Native file path does not match the item path. Update both together.');
        }
      }
      record.fileName = record.fileName || record.path.split(/[\\/]/).pop();
      record.fileName = requiredText(record.fileName, 'File name');
      if (record.size !== undefined && (!Number.isSafeInteger(record.size) || record.size < 0)) throw new Error('Invalid file size.');
      if (record.mime !== undefined && typeof record.mime !== 'string') throw new Error('File type must be text.');
    }
    return record;
  }

  class LibraryModel {
    constructor(snapshot = {}) {
      plainObject(snapshot, 'Library snapshot');
      if (snapshot.version !== undefined && snapshot.version !== 1) throw new Error('Unsupported library version.');
      this.fields = [];
      this.items = [];
      this.connections = [];
      this._fieldById = new Map();
      this._itemById = new Map();
      this._memberships = new Map();
      this._identityIndex = new Map();
      this._nativeReferenceIndex = new Map();
      const arrays = {};
      for (const key of ['fields', 'items', 'memberships', 'connections']) {
        arrays[key] = snapshot[key] === undefined ? [] : snapshot[key];
        if (!Array.isArray(arrays[key])) throw new Error(`Snapshot ${key} must be an array.`);
      }

      // Load fields before checking parent references so snapshot ordering is irrelevant.
      for (const source of arrays.fields) {
        const record = this._fieldRecord(source);
        if (this._fieldById.has(record.id)) throw new Error('Duplicate field ID.');
        this.fields.push(record);
        this._fieldById.set(record.id, record);
      }
      for (const field of this.fields) this._validateParent(field);

      for (const source of arrays.items) {
        plainObject(source, 'Item');
        if (owns(source, 'fields')) throw new Error('Snapshot items must use separate membership records.');
        const record = itemRecord(source);
        if (this._itemById.has(record.id)) throw new Error('Duplicate item ID.');
        const key = identityKey(record);
        if (key && this._identityIndex.has(key)) throw new Error('Duplicate canonical item identity.');
        this._insertItem(record, []);
      }
      const membershipPairs = new Set();
      for (const membership of arrays.memberships) {
        plainObject(membership, 'Membership');
        const itemId = identifier(membership.itemId, 'Membership item ID');
        const fieldId = identifier(membership.fieldId, 'Membership field ID');
        if (!this._itemById.has(itemId) || !this._fieldById.has(fieldId)) throw new Error('Membership refers to a missing item or field.');
        const pair = JSON.stringify([itemId, fieldId]);
        if (membershipPairs.has(pair)) throw new Error('Duplicate membership record.');
        membershipPairs.add(pair);
        this._memberships.get(itemId).add(fieldId);
      }
      for (const connection of arrays.connections) this.createConnection(connection);
    }

    _fieldRecord(source) {
      plainObject(source, 'Field');
      const record = dataCopy(source);
      record.id = identifier(record.id, 'Field ID');
      record.name = requiredText(record.name, 'Field name');
      if (typeof record.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(record.color)) throw new Error('Field color must be a six-digit hex color.');
      record.parent = record.parent ?? null;
      if (record.parent !== null) identifier(record.parent, 'Parent field ID');
      return record;
    }

    _validateParent(field) {
      const seen = new Set([field.id]);
      for (let parentId = field.parent; parentId !== null;) {
        if (seen.has(parentId)) throw new Error('Field hierarchy cannot contain a cycle.');
        seen.add(parentId);
        const parent = this._fieldById.get(parentId);
        if (!parent) throw new Error('Parent field does not exist.');
        parentId = parent.parent;
      }
    }

    _fieldIds(fieldIds) {
      if (!Array.isArray(fieldIds)) throw new Error('Field memberships must be an array.');
      const unique = [];
      for (const fieldId of fieldIds) {
        identifier(fieldId, 'Field ID');
        if (!this._fieldById.has(fieldId)) throw new Error('Field does not exist.');
        if (!unique.includes(fieldId)) unique.push(fieldId);
      }
      return unique;
    }

    _insertItem(record, fieldIds) {
      const referenceId = record.native?.referenceId;
      if (referenceId && this._nativeReferenceIndex.has(referenceId.toLowerCase())) throw new Error('Native reference ID already belongs to another item.');
      const memberships = new Set(fieldIds);
      this._memberships.set(record.id, memberships);
      Object.defineProperty(record, 'fields', { enumerable: true, get: () => [...memberships] });
      this.items.push(record);
      this._itemById.set(record.id, record);
      const key = identityKey(record);
      if (key) this._identityIndex.set(key, record.id);
      if (referenceId) this._nativeReferenceIndex.set(referenceId.toLowerCase(), record.id);
      return record;
    }

    createField(source) {
      const record = this._fieldRecord(source);
      if (this._fieldById.has(record.id)) throw new Error('Field ID already exists.');
      this._validateParent(record);
      this.fields.push(record);
      this._fieldById.set(record.id, record);
      return record;
    }

    createItem(source, fieldIds) {
      const record = itemRecord(source);
      const uniqueFields = this._fieldIds(fieldIds);
      if (this._itemById.has(record.id)) throw new Error('Item ID already exists.');
      const key = identityKey(record);
      const existingId = key && this._identityIndex.get(key);
      const referenceOwner = record.native?.referenceId && this._nativeReferenceIndex.get(record.native.referenceId.toLowerCase());
      if (referenceOwner && referenceOwner !== existingId) throw new Error('Native reference ID already belongs to another item.');
      if (existingId) {
        const memberships = this._memberships.get(existingId);
        const before = memberships.size;
        uniqueFields.forEach(fieldId => memberships.add(fieldId));
        return { itemId: existingId, created: false, added: memberships.size - before };
      }
      this._insertItem(record, uniqueFields);
      return { itemId: record.id, created: true, added: uniqueFields.length };
    }

    updateItem(id, patch) {
      const item = this._itemById.get(identifier(id, 'Item ID'));
      if (!item) throw new Error('Item does not exist.');
      plainObject(patch, 'Item update');
      if ((owns(patch, 'id') && patch.id !== id) || (owns(patch, 'kind') && patch.kind !== item.kind)) {
        throw new Error('Item ID and kind cannot be changed.');
      }
      const record = itemRecord({ ...item, ...patch, id, kind: item.kind });
      const oldKey = identityKey(item);
      const newKey = identityKey(record);
      const collision = newKey && this._identityIndex.get(newKey);
      if (collision && collision !== id) throw new Error('This URL, path, or native file identity already belongs to another item. Add that existing item to the field instead.');
      const oldReference = item.native?.referenceId;
      const newReference = record.native?.referenceId;
      const referenceOwner = newReference && this._nativeReferenceIndex.get(newReference.toLowerCase());
      if (referenceOwner && referenceOwner !== id) throw new Error('Native reference ID already belongs to another item.');
      // Validate completely before changing the canonical object or its identity index.
      if (oldKey && oldKey !== newKey) this._identityIndex.delete(oldKey);
      if (newKey) this._identityIndex.set(newKey, id);
      if (oldReference && oldReference !== newReference) this._nativeReferenceIndex.delete(oldReference.toLowerCase());
      if (newReference) this._nativeReferenceIndex.set(newReference.toLowerCase(), id);
      Object.assign(item, record);
      return item;
    }

    setMemberships(id, fieldIds) {
      identifier(id, 'Item ID');
      if (!this._itemById.has(id)) throw new Error('Item does not exist.');
      const unique = this._fieldIds(fieldIds);
      const memberships = this._memberships.get(id);
      memberships.clear();
      unique.forEach(fieldId => memberships.add(fieldId));
      return this._itemById.get(id);
    }

    createConnection(source) {
      plainObject(source, 'Connection');
      const record = dataCopy(source);
      record.id = identifier(record.id, 'Connection ID');
      if (this.connections.some(connection => connection.id === record.id)) throw new Error('Connection ID already exists.');
      record.from = identifier(record.from, 'Source field ID');
      record.to = identifier(record.to, 'Target field ID');
      if (!this._fieldById.has(record.from) || !this._fieldById.has(record.to)) throw new Error('Connection refers to a missing field.');
      if (record.from === record.to) throw new Error('Choose two different fields.');
      if (record.kind !== undefined && record.kind !== 'related') throw new Error('Unsupported connection kind.');
      record.kind = 'related';
      record.label = requiredText(record.label, 'Connection label');
      if (record.note !== undefined && typeof record.note !== 'string') throw new Error('Connection note must be text.');
      this.connections.push(record);
      return record;
    }

    snapshot() {
      return {
        version: 1,
        fields: dataCopy(this.fields),
        items: this.items.map(item => { const { fields, ...record } = item; return dataCopy(record); }),
        memberships: this.items.flatMap(item => item.fields.map(fieldId => ({ itemId: item.id, fieldId }))),
        connections: dataCopy(this.connections)
      };
    }
  }

  return { LibraryModel, identityKey };
});

/* Local metadata storage. File attachments are references, not archived copies. */
(function () {
  'use strict';

  function open(name = 'field-library-v1') {
    if (window.FieldDesktop?.isDesktop) {
      const desktop = window.FieldDesktop;
      const call = async (method, params = {}) => {
        await desktop.ready;
        return desktop.request(method, params, 60000);
      };
      return {
        load: () => call('library.load'),
        save: (snapshot, expectedRevision) => call('library.save', { snapshot, expectedRevision }),
        import: (snapshot, expectedRevision) => call('library.import', { snapshot, expectedRevision })
      };
    }
    let databasePromise;

    function database() {
      if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error('Local storage is unavailable. Open FIELD in a browser with IndexedDB enabled.'));
          return;
        }
        let failed = false;
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('library');
        };
        request.onerror = () => {
          failed = true;
          reject(request.error || new Error('Could not open the local library.'));
        };
        request.onblocked = () => {
          failed = true;
          reject(new Error('Close other FIELD windows and reload to open the library.'));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (failed) { db.close(); return; }
          db.onversionchange = () => db.close();
          resolve(db);
        };
      });
      return databasePromise;
    }

    async function load() {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('library', 'readonly');
        const request = transaction.objectStore('library').get('current');
        let value;
        request.onsuccess = () => { value = request.result; };
        transaction.oncomplete = () => {
          if (value === undefined) {
            resolve({ revision: 0, snapshot: { version: 1, fields: [], items: [], memberships: [], connections: [] } });
          } else if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
                     !Object.hasOwn(value, 'snapshot') || !value.snapshot || value.snapshot.version !== 1 ||
                     ['fields', 'items', 'memberships', 'connections'].some(key => !Array.isArray(value.snapshot[key]))) {
            reject(new Error('The saved library is invalid. It has not been overwritten.'));
          } else resolve(value);
        };
        transaction.onerror = () => reject(transaction.error || new Error('Could not read the local library.'));
        transaction.onabort = () => reject(transaction.error || new Error('Reading the local library was interrupted.'));
      });
    }

    async function save(snapshot, expectedRevision) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('library', 'readwrite');
        const store = transaction.objectStore('library');
        const request = store.get('current');
        let failure;
        let nextRevision;
        request.onsuccess = () => {
          const revision = request.result?.revision || 0;
          if (revision !== expectedRevision) {
            failure = new Error('The library changed in another window. Reload FIELD before saving.');
            transaction.abort();
            return;
          }
          nextRevision = revision + 1;
          try {
            store.put({ revision: nextRevision, snapshot }, 'current');
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
        transaction.oncomplete = () => resolve({ revision: nextRevision });
        transaction.onerror = () => reject(failure || transaction.error || new Error('The library could not be saved.'));
        transaction.onabort = () => reject(failure || transaction.error || new Error('The library could not be saved.'));
      });
    }

    return { load, save };
  }

  window.FieldStorage = { open };
})();

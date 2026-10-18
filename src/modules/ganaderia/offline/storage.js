// SPRINT-3D11.3 (R1) -- adaptador de almacenamiento local. Mismo contrato
// para IndexedDB (navegador y Service Worker) y para memoria (pruebas y
// futuros entornos: Capacitor puede aportar su propio adaptador):
//
//   get(store, key) -> valor | undefined
//   getAll(store) -> valor[]
//   getAllByIndex(store, index, value) -> valor[]
//   put(store, valor)  delete(store, key)  clear(store)
//   batch([{ op:'put'|'delete'|'clear', store, value?, key? }]) -- ATÓMICO
//   close()
//
// Sin dependencias de React ni del DOM (window): utilizable desde el SW.

/** Adaptador en memoria (pruebas). Copia profunda en cada lectura/escritura. */
export function createMemoryStorage(schema) {
  const stores = new Map(Object.keys(schema).map((name) => [name, new Map()]));
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  const storeOf = (name) => {
    const store = stores.get(name);
    if (!store) throw new Error(`STORE_DESCONOCIDO:${name}`);
    return store;
  };
  const keyOf = (name, value) => value[schema[name].keyPath];
  const apply = (operation) => {
    const store = storeOf(operation.store);
    if (operation.op === 'put') store.set(keyOf(operation.store, operation.value), clone(operation.value));
    else if (operation.op === 'delete') store.delete(operation.key);
    else if (operation.op === 'clear') store.clear();
    else throw new Error(`OPERACION_DESCONOCIDA:${operation.op}`);
  };
  return {
    kind: 'memory',
    async get(name, key) {
      return clone(storeOf(name).get(key));
    },
    async getAll(name) {
      return [...storeOf(name).values()].map(clone);
    },
    async getAllByIndex(name, index, value) {
      const path = schema[name].indexes.find(([indexName]) => indexName === index)?.[1];
      if (!path) throw new Error(`INDICE_DESCONOCIDO:${name}.${index}`);
      return [...storeOf(name).values()].filter((row) => row[path] === value).map(clone);
    },
    async put(name, value) {
      apply({ op: 'put', store: name, value });
    },
    async delete(name, key) {
      apply({ op: 'delete', store: name, key });
    },
    async clear(name) {
      apply({ op: 'clear', store: name });
    },
    async batch(operations) {
      // Validar todo antes de aplicar: atomicidad equivalente a una transacción.
      for (const operation of operations) storeOf(operation.store);
      const snapshot = new Map([...stores].map(([name, store]) => [name, new Map(store)]));
      try {
        operations.forEach(apply);
      } catch (error) {
        for (const [name, store] of snapshot) stores.set(name, store);
        throw error;
      }
    },
    async close() {},
  };
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('TX_ABORTED'));
  });
}

/** Abre (y migra) una base IndexedDB según el esquema. */
export function openIndexedDb(idb, name, version, schema) {
  return new Promise((resolve, reject) => {
    const request = idb.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [storeName, def] of Object.entries(schema)) {
        const store = db.objectStoreNames.contains(storeName)
          ? request.transaction.objectStore(storeName)
          : db.createObjectStore(storeName, { keyPath: def.keyPath });
        for (const [indexName, path, unique] of def.indexes) {
          if (!store.indexNames.contains(indexName)) store.createIndex(indexName, path, { unique });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IDB_BLOCKED'));
  });
}

/** Adaptador IndexedDB sobre una base ya abierta. */
export function createIndexedDbStorage(db) {
  const read = async (name, fn) => {
    const tx = db.transaction(name, 'readonly');
    const result = await promisify(fn(tx.objectStore(name)));
    await txDone(tx);
    return result;
  };
  const write = async (names, operations) => {
    const tx = db.transaction(names, 'readwrite');
    for (const operation of operations) {
      const store = tx.objectStore(operation.store);
      if (operation.op === 'put') store.put(operation.value);
      else if (operation.op === 'delete') store.delete(operation.key);
      else if (operation.op === 'clear') store.clear();
      else {
        tx.abort();
        throw new Error(`OPERACION_DESCONOCIDA:${operation.op}`);
      }
    }
    await txDone(tx);
  };
  return {
    kind: 'indexeddb',
    get: (name, key) => read(name, (store) => store.get(key)),
    getAll: (name) => read(name, (store) => store.getAll()),
    getAllByIndex: (name, index, value) => read(name, (store) => store.index(index).getAll(value)),
    put: (name, value) => write([name], [{ op: 'put', store: name, value }]),
    delete: (name, key) => write([name], [{ op: 'delete', store: name, key }]),
    clear: (name) => write([name], [{ op: 'clear', store: name }]),
    batch: (operations) => (operations.length === 0
      ? Promise.resolve()
      : write([...new Set(operations.map((operation) => operation.store))], operations)),
    async close() {
      db.close();
    },
  };
}

/** Elimina una base IndexedDB completa (purga de organización). */
export function deleteIndexedDb(idb, name) {
  return new Promise((resolve, reject) => {
    const request = idb.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

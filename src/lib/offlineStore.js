const DB_NAME = 'agrogenomax-offline';
const DB_VERSION = 1;
const STORE_NAME = 'sync_queue';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB no esta disponible en este dispositivo.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('tableName', 'tableName');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function enqueueOfflineMutation(tableName, payload, action = 'insert') {
  const db = await openDatabase();
  const item = {
    id: crypto.randomUUID(),
    tableName,
    payload,
    action,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  db.close();
  return item;
}

export async function listOfflineQueue() {
  const db = await openDatabase();
  const items = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  db.close();
  return items;
}

export async function clearOfflineItem(id) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function getOfflineCapability() {
  return {
    indexedDb: typeof window !== 'undefined' && 'indexedDB' in window,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  };
}

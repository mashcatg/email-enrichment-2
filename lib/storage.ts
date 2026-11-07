import type { EnrichmentProject } from "@/lib/types";

const DATABASE_NAME = "email-enrichment";
const STORE_NAME = "projects";
const PROJECT_KEY = "active";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local storage."));
    request.onblocked = () => reject(new Error("Local storage is blocked by another browser tab."));
  });
}

export async function readProject(): Promise<EnrichmentProject | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(PROJECT_KEY);
    let project: EnrichmentProject | null = null;
    request.onsuccess = () => {
      project = request.result?.project ?? null;
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(project);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? request.error ?? new Error("Could not read the saved project."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Reading the saved project was interrupted."));
    };
  });
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

export async function writeProject(project: EnrichmentProject): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ key: PROJECT_KEY, project });
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save the project locally."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Saving the project was interrupted."));
    };
  });
}

export async function deleteProject(): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(PROJECT_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not clear the saved project."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Clearing the project was interrupted."));
    };
  });
}

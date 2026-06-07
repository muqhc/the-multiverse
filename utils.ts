import { walk } from "walkjs";
import { compressToBase64, decompressFromBase64 } from "lz-string";
import { IndexedDBDataItem, Meta, Project, ValueType, WeakStorage } from "./types";

export function flattenObject(obj: any, prefix = ''): Record<string, ValueType> {
  let newObj: Record<string, ValueType> = {};
  walk(obj, {
    onVisit: {
      callback: node => {
        let raw = node.getPath()
        let key = raw.substring(1, raw.length - 1).replaceAll("][", '.').replaceAll("\"", "\'");
        newObj[key] = node.val;
      },
      filters: node => node.nodeType !== 'object' && node.nodeType !== 'array'
    }
  });
  return newObj;
}

export function unflattenObject(data: Record<string, ValueType>, base: Record<string, ValueType> = {}): any {
  let result: any = parseJson(JSON.stringify(base));
  for (const rawKey in data) {
    const keys = rawKey.split('.');
    keys.reduce((acc, k, j) => {
      k = k.replaceAll("\'", "")
      if (keys[j + 1]?.includes("\'")) {
        return acc[k] || (acc[k] = {});
      }
      if (keys[j + 1]) {
        return acc[k] || (acc[k] = []);
      }
      return acc[k] = data[rawKey];
    }, result);
  }
  return result;
}

export const APP_DB_ID = "the_multiverse";

let storageWarningAlerted = false;

// const p = parseJson
// parseJson = (v) => { console.log(v); return p(v) }

export function useStorage(name: string, callback: (storage: WeakStorage) => void, dbId: string = APP_DB_ID) {
  if (!window.indexedDB || new URLSearchParams(window.location.search).get("useLocalStorage") == "true") {
    if (!storageWarningAlerted) {
      storageWarningAlerted = true;
      const message = !window.indexedDB
        ? "This browser does not support IndexedDB.\nUsing LocalStorage for data storage.\nSize of saved data might be limited to ~5MB."
        : "This browser is using LocalStorage for data storage.\nSize of saved data might be limited to ~5MB.\nFor now, this is for only dev or migrating projects to IndexedDB.\nTo migrate to IndexedDB, export project files via Export button in the header and import them back in IndexedDB."
      console.warn(message);
      alert(message);
    }
    const delegate: WeakStorage = {
      setItem: (key: string, value: string) => {
        localStorage.setItem(key, value);
      },
      removeItem: (key: string) => {
        localStorage.removeItem(key);
      },
      getItemCallback: (key: string, callback: (value: string | null) => void) => {
        callback(localStorage.getItem(key));
      }
    };
    callback(delegate);
    return;
  }

  const request = window.indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("data", { keyPath: "key" });
  };
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction(["data"], "readwrite");
    const store = transaction.objectStore("data");
    const delegate: WeakStorage = {
      getItemCallback: (key: string, callback: (value: string | null) => void) => {
        store.get(key).onsuccess = (event) => {
          const result = (event.target as IDBRequest).result as IndexedDBDataItem | undefined;
          callback(result?.value || null);
        }
      },
      setItem: (key: string, value: string) => {
        store.put({ key, value });
      },
      removeItem: (key: string) => {
        store.delete(key);
      }
    };
    callback(delegate);
  };


}



export function saveToLocal(key: string, data: any) {
  useStorage(key, (storage) => {
    const text = JSON.stringify(data);

    let segments: { key: string, size: number, sub: string }[] = [];
    for (let i = 0; i <= text.length / 5000000; i++) {
      const sub = text.substring(i * 5000000, (i + 1) * 5000000);
      segments.push({ key: `${key}_seg${i}`, size: sub.length, sub: sub });
    }

    let reduced: string = segments.reduce((acc, seg) => (acc + seg.sub), "");
    if (text !== reduced) {
      alert(`Constructed data length mismatch for key: ${key} (${text.length} != ${reduced.length})`);
      return;
    }

    storage.getItemCallback(`${key}_meta`, (value) => {
      const currentMeta = value ? parseJson(value) as Meta : { segments: [], length: 0 };

      segments.forEach((seg) => {
        storage.setItem(seg.key, seg.sub);
      });

      for (const seg of currentMeta.segments) {
        if (!segments.some(s => s.key === seg.key)) {
          storage.removeItem(seg.key);
        }
      }

      const meta = { segments, length: text.length };
      storage.setItem(`${key}_meta`, JSON.stringify(meta));
    });

  });
}

export function loadFromLocalCallback(key: string, callback: (data: any) => void) {
  useStorage(key, (storage) => {
    storage.getItemCallback(`${key}_meta`, (metaRaw) => {
      if (!metaRaw) {
        storage.getItemCallback(key, (unSegDataRaw) => {
          if (!unSegDataRaw) {
            callback({});
            return;
          }
          callback(parseJson(unSegDataRaw));
        });
        return;
      }
      const meta = parseJson(metaRaw) as Meta;
      const { segments, length } = meta;
      parallelLoadCallback<{ key: string, size: number }, string>(
        segments, (seg, callback) => storage.getItemCallback(seg.key, callback),
        (values) => {
          const text = values.reduce((acc, val) => acc + val, "");
          if (text.length !== length) {
            throw new Error(`Constructed data length mismatch for key: ${key} (${text.length} != ${length})`);
          }
          callback(parseJson(text));
        }
      )
    });
  });
}

export function textToBytes(text: string) {
  const encoder = new TextEncoder();
  return encoder.encode(text);
}

export function bytesToText(bytes: Uint8Array) {
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

export function base64ToBytes(base64: string) {
  const binString = atob(base64);
  return Uint8Array.from(binString, (m) => m.codePointAt(0));
}

export function bytesToBase64(bytes: Uint8Array) {
  const binString = Array.from(bytes, (x) => String.fromCodePoint(x)).join("");
  return btoa(binString);
}

export function downloadFile(filename: string, content: string, contentType: string = 'application/json') {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function importProjectFromText(text: string) {
  const importedProject = parseJson(text) as Project;

  if (!importedProject.id || !importedProject.name || !importedProject.config || !importedProject.rows) {
    throw new Error("Invalid project file format");
  }

  const newProject = {
    ...importedProject,
    id: crypto.randomUUID(),
    lastUpdated: Date.now()
  };

  return newProject;
}

export function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn("Failed to parse JSON", text);
    console.error(e);
    downloadFile("parsingFailed.json", text);
    throw e;
  }
}

const WIP = Symbol("WIP");
export function parallelLoadCallback<T, R>(queries: T[], loader: (query: T, callback: (value: R | null) => void) => void, callback: (values: (R | null)[]) => void) {
  let index = 0;
  let results: (R | null | typeof WIP)[] = Array(queries.length).fill(WIP);
  queries.forEach((query, index) => {
    loader(query, (value) => {
      results[index] = value;
      if (!results.includes(WIP)) {
        callback(results as (R | null)[]);
      }
    });
  });
}

export function compressText(text: string) {
  return compressToBase64(text);
}

export function decompressText(text: string) {
  return decompressFromBase64(text);
}

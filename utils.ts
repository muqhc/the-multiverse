import { walk } from "walkjs";
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
  let result: any = JSON.parse(JSON.stringify(base));
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

const APP_DB_ID = "the_multiverse";

// const p = JSON.parse
// JSON.parse = (v) => { console.log(v); return p(v) }

export function useStorage(name: string, callback: (storage: WeakStorage) => void, dbId: string = APP_DB_ID) {
  if (!window.indexedDB) {
    alert("IndexedDB not supported. localStorage is used instead. Data will be missing when migrated. Please download project files and as backup.");
    const delegate: WeakStorage = {
      ...localStorage,
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
    storage.getItemCallback(`${key}_meta`, (value) => {
      const currentMeta = value ? JSON.parse(value) as Meta : { segments: [], length: 0 };

      let segments: { key: string, size: number }[] = [];
      for (let i = 0; i <= text.length / 5000000; i++) {
        const sub = text.substring(i * 5000000, (i + 1) * 5000000);
        segments.push({ key: `${key}_seg${i}`, size: sub.length });
        storage.setItem(`${key}_seg${i}`, sub);
      }

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
          callback(JSON.parse(unSegDataRaw));
        });
        return;
      }
      const meta = JSON.parse(metaRaw) as Meta;
      const { segments, length } = meta;
      segments.reduce<(string) => void>((acc, seg) => {
        return (text: string) => storage.getItemCallback(seg.key, (value) => {
          acc(text + value)
        });
      }, (text: string) => {
        if (text.length !== length) {
          throw new Error(`Constructed data length mismatch for key: ${key} (${text.length} != ${length})`);
        }
        callback(JSON.parse(text));
      })("");
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

export function importProject(content: string) {
  const importedProject = JSON.parse(content) as Project;

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





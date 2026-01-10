import { walk } from "walkjs";
import { ValueType } from "./types";

export function flattenObject(obj: any, prefix = ''): Record<string, ValueType> {
  let newObj: Record<string, ValueType> = {};
  walk(obj,{
    onVisit: {
      callback: node => {
        let raw = node.getPath()
        let key = raw.substring(1,raw.length-1).replaceAll("][",'.').replaceAll("\"","\'");
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
      k = k.replaceAll("\'","")
      if (keys[j + 1]?.includes("\'")) {
        return acc[k] || (acc[k] = {});
      }
      if (keys[j + 1]) {
        return acc[k] || (acc[k] = []);
      }
      return acc[k] = data[rawKey];
    },result);
  }
  return result;
}

export function saveToLocal(key: string, data: any) {
  localStorage.setItem(key, JSON.stringify(data));
}

export function loadFromLocal(key: string) {
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : null;
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
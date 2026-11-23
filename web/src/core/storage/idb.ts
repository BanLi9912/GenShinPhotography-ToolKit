import { openDB, type IDBPDatabase } from "idb";

/**
 * 应用级 IndexedDB 单例（§3.3 core/storage：IndexedDB 封装）。
 * - boards：画板/排版工程文档 JSON（§4.3），key 为文档 id
 * - assets：图片等二进制本体（Blob），key 为资产 id；文档内只存 blob-ref 引用
 * - libraries：M3 图库注册表（M3.1），key = libraryId，值为可结构化克隆的
 *   FileSystemDirectoryHandle 等注册信息（见 modules/library/index/binding.ts）
 * - settings：M3.5 全局设置（key-value，跨图库共享；见 modules/library/vision/settings.ts）
 */

const DB_NAME = "ystk";
const DB_VERSION = 3;

export const BOARDS_STORE = "boards";
export const ASSETS_STORE = "assets";
export const LIBRARIES_STORE = "libraries";
export const SETTINGS_STORE = "settings";

let dbPromise: Promise<IDBPDatabase> | null = null;

/** 打开（并复用）应用数据库；按 oldVersion 条件建表，老库 1→2 升级安全 */
export function getDB(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore(BOARDS_STORE);
        db.createObjectStore(ASSETS_STORE);
      }
      if (oldVersion < 2) {
        db.createObjectStore(LIBRARIES_STORE);
      }
      if (oldVersion < 3) {
        db.createObjectStore(SETTINGS_STORE);
      }
    },
  });
  return dbPromise;
}

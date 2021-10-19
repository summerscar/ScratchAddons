import Addon from "../../addon-api/background/Addon.js";
// Intentional circular import
// ESM so this is fine
import changeAddonState from "./change-addon-state.js";
import { getMissingOptionalPermissions } from "./util.js";

export default async function runPersistentScripts(addonId) {
  const manifest = scratchAddons.manifests.find((obj) => obj.addonId === addonId).manifest;
  const permissions = manifest.permissions || [];
  const missing = await getMissingOptionalPermissions();
  if (permissions.some((p) => missing.includes(p))) {
    console.warn("Disabled addon", addonId, "due to missing optional permission");
    changeAddonState(addonId, false);
    return;
  }
  if (manifest.persistentScripts)
    executePersistentScripts({ addonId, permissions, scriptUrls: manifest.persistentScripts });
}

// 执行 addon 的 persistentScripts 列表

async function executePersistentScripts({ addonId, permissions, scriptUrls }) {
  const addonObjReal = new Addon({ id: addonId, permissions });
  // https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy/revocable
  const addonObjRevocable = Proxy.revocable(addonObjReal, {});
  const addonObj = addonObjRevocable.proxy;
  scratchAddons.addonObjects.push(addonObjReal);
  const clearTimeoutFunc = (timeoutId) => {
    addonObjReal._timeouts.splice(
      addonObjReal._timeouts.findIndex((x) => x === timeoutId),
      1
    );
    return clearTimeout(timeoutId);
  };
  const clearIntervalFunc = (intervalId) => {
    addonObjReal._intervals.splice(
      addonObjReal._intervals.findIndex((x) => x === intervalId),
      1
    );
    return clearInterval(intervalId);
  };
   // 包装原生 setTimeout，保存任务Id 执行后立即清除当前 setTimeout
  const setTimeoutFunc = function (func, interval) {
    const timeoutId = setTimeout(function () {
      func();
      clearTimeoutFunc(timeoutId);
    }, interval);
    addonObjReal._timeouts.push(timeoutId);
    return timeoutId;
  };
  // 包装原生 setInterval 保存任务Id
  const setIntervalFunc = function (func, interval) {
    const intervalId = setInterval(function () {
      func();
    }, interval);
    addonObjReal._intervals.push(intervalId);
    return intervalId;
  };
  addonObjReal._revokeProxy = () => {
    scratchAddons.addonObjects.splice(
      scratchAddons.addonObjects.findIndex((x) => x === addonObjReal),
      1
    );
    // 取消代理
    addonObjRevocable.revoke();
  };

  addonObjReal._restart = () => {
    // 清除 异步任务 / auth / self /settings / notification
    addonObjReal._kill();
    executePersistentScripts({ addonId, permissions, scriptUrls });
  };
  const globalObj = Object.create(null);

  for (const scriptPath of scriptUrls) {
    const scriptUrl = chrome.runtime.getURL(`/addons/${addonId}/${scriptPath}`);
    console.log(
      `%cDebug addons/${addonId}/${scriptPath}: ${scriptUrl}`,
      "color:red; font-weight: bold; font-size: 1.2em;"
    );
    // https://zhuanlan.zhihu.com/p/129909021
    const module = await import(chrome.runtime.getURL(`addons/${addonId}/${scriptPath}`));
    const log = console.log.bind(console, `%c[${addonId}]`, "color:darkorange; font-weight: bold;");
    const warn = console.warn.bind(console, `%c[${addonId}]`, "color:darkorange font-weight: bold;");
    // 国际化函数
    const msg = (key, placeholders) =>
      scratchAddons.l10n.get(key.startsWith("/") ? key.slice(1) : `${addonId}/${key}`, placeholders);
    msg.locale = scratchAddons.l10n.locale;
    module.default({
      addon: addonObj,   // 传入被 proxy 后的addon实例
      global: globalObj,
      console: { ...console, log, warn },
      setTimeout: setTimeoutFunc,
      setInterval: setIntervalFunc,
      clearTimeout: clearTimeoutFunc,
      clearInterval: clearIntervalFunc,
      msg,
    });
  }
}

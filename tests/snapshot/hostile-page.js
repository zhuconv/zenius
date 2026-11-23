// A hostile page for tests/snapshot/hostile.test.mjs, injected as a page
// script. Once it runs, every method, getter and setter of every prototype
// in the page's realm, and the window's own functions and getters, is a
// trap. Each call checks what it was handed (this, arguments, a setter's
// value) for an object of another realm: zen-snapshot's sandbox shares the
// page's compartment, so any object of ours a page function receives leads
// it to the sandbox's global.
//
// MODE "spy": the traps then return the real result, so snapshots run as on
// any page. MODE "hostile": a string the page returns comes back as a
// String object whose methods check their arguments too, which is how the
// audit's probe got in (getAttribute returning an object with split).
//
// Results go to window.__hostile = {leaks, calls}; the page runs nothing
// after this script, so every trap call comes from zenius. The traps use
// index loops only: spreads and for...of would call the page's own (trapped)
// array iterator.
(() => {
  "use strict";
  const MODE = "%MODE%";
  const apply = Reflect.apply;
  const getProto = Reflect.getPrototypeOf;
  const ownKeys = Reflect.ownKeys;
  const getDesc = Reflect.getOwnPropertyDescriptor;
  const define = Reflect.defineProperty;
  const reflectGet = Reflect.get;
  const PageObject = Object;
  const PageString = String;
  const PageProxy = Proxy;
  const weakHas = WeakSet.prototype.has;
  const weakAdd = WeakSet.prototype.add;
  const win = window;
  const mine = new WeakSet();
  const report = { leaks: [], calls: 0 };

  /** An object or function of another realm: its prototype chain misses this realm's Object.prototype. */
  function foreign(x) {
    if (x === null || (typeof x !== "object" && typeof x !== "function") || apply(weakHas, mine, [x])) return false;
    try {
      let p = x;
      for (let i = 0; i < 100; i++) {
        p = getProto(p);
        if (p === null) return true;
        if (p === PageObject.prototype) return false;
      }
    } catch {
      return true;
    }
    return false;
  }

  function note(where, value) {
    if (!foreign(value)) return;
    let what = typeof value;
    try {
      const global = value.constructor.constructor("return this")();
      if (global && global !== win) {
        what = "the sandbox's global:";
        const keys = ownKeys(global);
        for (let i = 0; i < keys.length; i++) {
          // startsWith: a boolean, which hostile mode never boxes.
          if (typeof keys[i] === "string" && keys[i].startsWith("__zs")) what += ` ${keys[i]}`;
        }
      }
    } catch {}
    if (report.leaks.length < 20) report.leaks[report.leaks.length] = `${where}: ${what}`;
  }

  function check(where, self, args) {
    note(where, self);
    for (let i = 0; i < args.length; i++) note(where, args[i]);
  }

  /** A string as a String object whose methods check what they're given. */
  function box(real, where) {
    const proxy = new PageProxy(new PageString(real), {
      get(target, key) {
        if (key === Symbol.toPrimitive || key === "toString" || key === "valueOf") return () => real;
        const value = reflectGet(target, key, target);
        if (typeof value !== "function") return value;
        return function (...args) {
          check(`${where} (string).${PageString(key)}`, this === proxy ? undefined : this, args);
          return apply(value, real, args);
        };
      },
    });
    apply(weakAdd, mine, [proxy]);
    return proxy;
  }
  const result = (value, where) => (MODE === "hostile" && typeof value === "string" ? box(value, where) : value);

  function trap(owner, label, skipConstructors) {
    const keys = ownKeys(owner);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === "constructor") continue;
      const desc = getDesc(owner, key);
      if (!desc || !desc.configurable) continue;
      const where = `${label}.${PageString(key)}`;
      if (typeof desc.value === "function") {
        const fn = desc.value;
        if (skipConstructors && fn.prototype && typeof fn.prototype === "object") continue;
        desc.value = function (...args) {
          report.calls++;
          check(where, this, args);
          return result(apply(fn, this, args), where);
        };
      } else if (desc.get || desc.set) {
        const get = desc.get;
        const set = desc.set;
        if (get) {
          desc.get = function () {
            report.calls++;
            check(where, this, []);
            return result(apply(get, this, []), where);
          };
        }
        if (set) {
          desc.set = function (value) {
            report.calls++;
            check(`${where} =`, this, [value]);
            return apply(set, this, [value]);
          };
        }
      } else {
        continue;
      }
      define(owner, key, desc);
    }
  }

  const names = ownKeys(win);
  const prototypes = [];
  for (let i = 0; i < names.length; i++) {
    if (typeof names[i] !== "string") continue;
    let value;
    try {
      value = win[names[i]];
    } catch {
      continue;
    }
    if (typeof value === "function" && value.prototype && typeof value.prototype === "object") {
      prototypes[prototypes.length] = [value.prototype, names[i]];
    }
  }
  win.__hostile = report;
  // The window's own functions and getters (getComputedStyle, innerWidth),
  // then every prototype in the realm.
  trap(win, "window", true);
  for (let i = 0; i < prototypes.length; i++) trap(prototypes[i][0], prototypes[i][1], false);
  report.calls = 0;
  report.leaks.length = 0;
})();

/**
 * Shared DOM/PrestaShop stub for the front.js tests.
 *
 * Deliberately hand-rolled rather than pulling in jsdom: the module's
 * front-end code only touches a small, well-defined slice of the DOM API,
 * and keeping the stub dependency-free means CI needs nothing but node.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl(tag, attrs, className) {
  const el = {
    tagName: tag.toUpperCase(),
    className: className || '',
    _attrs: Object.assign({}, attrs || {}),
    parentElement: null,
    children: [],
    textContent: '',
    _visible: false,
    get offsetParent() { return this._visible ? { tagName: 'BODY' } : null; },
    classList: {
      contains(c) { return String(el.className || '').split(/\s+/).includes(c); },
      add(c) { el.className = (el.className ? el.className + ' ' : '') + c; },
    },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    getAttribute(n) { return this.hasAttribute(n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    matches(sel) { return selectorMatches(this, sel); },
    closest(sel) {
      let node = this;
      while (node) {
        if (selectorMatches(node, sel)) return node;
        node = node.parentElement;
      }
      return null;
    },
    /** Searches descendants, which is what watchForSuccess relies on. */
    querySelector(sel) {
      const walk = (node) => {
        for (const child of node.children) {
          if (selectorMatches(child, sel)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        node.children.forEach((child) => {
          if (selectorMatches(child, sel)) out.push(child);
          walk(child);
        });
      };
      walk(this);
      return out;
    },
  };
  return el;
}

/** Supports the selector forms front.js actually uses. */
function selectorMatches(el, selector) {
  if (!el || !selector) return false;
  return String(selector).split(',').some((raw) => {
    const part = raw.trim();
    if (!part) return false;
    const classes = String(el.className || '').split(/\s+/).filter(Boolean);

    /** [attr], [attr=v], [attr*=v], [attr^=v] - quotes optional. */
    const attrTest = (clause) => {
      const m = clause.match(/^\[([a-zA-Z_:-]+)([*^$~|]?)=?["']?([^"'\]]*)["']?\]$/);
      if (!m) return false;
      const [, name, op, value] = m;
      if (!el.hasAttribute(name)) return false;
      if (value === '') return true;
      const actual = String(el.getAttribute(name) || '');
      if (op === '*') return actual.includes(value);
      if (op === '^') return actual.startsWith(value);
      if (op === '$') return actual.endsWith(value);
      return actual === value;
    };

    // [class*="x"] - checked against className, which our stub keeps
    // separate from the attribute map.
    const classContains = part.match(/^\[class\*=["']([^"']+)["']\]$/);
    if (classContains) return String(el.className || '').includes(classContains[1]);

    // bare attribute clause
    if (/^\[[^\]]+\]$/.test(part)) return attrTest(part);

    // #id
    if (/^#[\w-]+$/.test(part)) return el.getAttribute('id') === part.slice(1);

    // .a.b / .a
    if (part.startsWith('.') && !part.includes(' ') && !part.includes('[')) {
      return part.split('.').filter(Boolean).every((c) => classes.includes(c));
    }

    // tag / #id / .class followed by any number of attribute clauses
    const compound = part.match(/^([a-z]+|#[\w-]+|\.[\w-]+)((?:\[[^\]]+\])*)$/i);
    if (compound) {
      const [, head, attrs] = compound;
      if (head.startsWith('#')) {
        if (el.getAttribute('id') !== head.slice(1)) return false;
      } else if (head.startsWith('.')) {
        if (!classes.includes(head.slice(1))) return false;
      } else if (el.tagName !== head.toUpperCase()) {
        return false;
      }
      const clauses = attrs.match(/\[[^\]]+\]/g) || [];
      return clauses.every(attrTest);
    }

    // descendant "a b" - approximate via ancestor walk on the last token
    if (part.includes(' ')) {
      const tokens = part.split(/\s+/);
      const last = tokens[tokens.length - 1];
      if (!selectorMatches(el, last)) return false;
      let node = el.parentElement;
      while (node) {
        if (selectorMatches(node, tokens.slice(0, -1).join(' '))) return true;
        node = node.parentElement;
      }
      return false;
    }

    if (/^[a-z]+$/i.test(part)) return el.tagName === part.toUpperCase();
    return false;
  });
}

function buildEnvironment() {
  const listeners = {};
  const documentEl = makeEl('body');

  // Elements registered via document._add() form the searchable "page", so
  // querySelector actually resolves - front.js relies on it for the
  // newsletter success notice and the review confirmation modal.
  const registry = [];
  const collect = (el, out) => {
    out.push(el);
    (el.children || []).forEach((c) => collect(c, out));
    return out;
  };
  const allNodes = () => registry.reduce((acc, el) => collect(el, acc), []);

  const document = {
    readyState: 'complete',
    body: documentEl,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) {
      return allNodes().find((el) => selectorMatches(el, sel)) || null;
    },
    querySelectorAll(sel) {
      return allNodes().filter((el) => selectorMatches(el, sel));
    },
    _add(el) { registry.push(el); return el; },
    _dispatch(type, target) {
      (listeners[type] || []).forEach((fn) => fn({ type, target }));
    },
  };

  const psHandlers = {};
  const wishlistHandlers = {};

  const win = {
    document,
    dataLayer: [],
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    clearInterval: (id) => clearInterval(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    getComputedStyle: (el) => ({
      display: el && el._visible ? 'block' : 'none',
      visibility: el && el._visible ? 'visible' : 'hidden',
    }),
    psGa4Config: { currency: 'EUR', trackPromotions: true, trackEngagement: true },
    psGa4ListItems: {},
    psGa4CurrentItem: null,
    prestashop: {
      on(evt, cb) { (psHandlers[evt] = psHandlers[evt] || []).push(cb); },
      emit(evt, data) { (psHandlers[evt] || []).forEach((cb) => cb(data)); },
    },
    MutationObserver: function (cb) {
      return {
        observe() { this._t = setInterval(cb, 20); },
        disconnect() { clearInterval(this._t); },
      };
    },
    IntersectionObserver: undefined,
  };
  win.window = win;

  /** Stand-in for blockwishlist's Vue EventBus, exposed exactly as it does. */
  const wishlistBus = {
    $on(evt, cb) { (wishlistHandlers[evt] = wishlistHandlers[evt] || []).push(cb); },
    $emit(evt, payload) { (wishlistHandlers[evt] || []).forEach((cb) => cb(payload)); },
  };

  return { win, document, wishlistBus };
}

function loadFrontJs(env) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'ps_ga4_datalayer', 'views', 'js', 'front.js'),
    'utf8'
  );
  const ctx = vm.createContext(
    Object.assign(env.win, { console, Object, Array, String, Number, Math, JSON, parseFloat, parseInt, isNaN, WeakSet, Date })
  );
  vm.runInContext(src, ctx);
}


function loadFrontJs(env) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'ps_ga4_datalayer', 'views', 'js', 'front.js'),
    'utf8'
  );
  const ctx = vm.createContext(
    Object.assign(env.win, {
      console, Object, Array, String, Number, Math, JSON,
      parseFloat, parseInt, isNaN, WeakSet, Date, RegExp,
    })
  );
  vm.runInContext(src, ctx);
}

/** Events of a given name currently in the stub dataLayer. */
function eventsNamed(win, name) {
  return win.dataLayer.filter((e) => e && e.event === name);
}

module.exports = {makeEl, selectorMatches, buildEnvironment, loadFrontJs, eventsNamed};

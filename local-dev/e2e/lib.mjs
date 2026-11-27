// Shared harness: a browser context that records every window.dataLayer push
// across navigations, with GTM/GA network calls blocked (no real container).
import { chromium } from 'playwright';

export const BASE = (process.env.SHOP_URL || 'http://localhost:8080').replace(/\/$/, '');

export async function startBrowser() {
    const browser = await chromium.launch();
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1366, height: 900 } });
    // Only the local shop is reachable: GTM/GA, social share targets, PrestaShop SaaS modules stay offline.
    const shopHost = new URL(BASE).host;
    await context.route('**/*', (route) =>
        new URL(route.request().url()).host === shopHost ? route.continue() : route.abort()
    );

    const pushes = [];
    await context.exposeBinding('__dlRecord', ({ page }, json) => {
        pushes.push({ seq: pushes.length, url: page.url(), data: JSON.parse(json) });
    });
    await context.addInitScript(() => {
        const wrap = (arr) => {
            if (!Array.isArray(arr) || arr.__recorded) {
                return arr;
            }
            const original = arr.push;
            Object.defineProperty(arr, '__recorded', { value: true });
            arr.push = function (...items) {
                for (const item of items) {
                    // gtag() pushes an `arguments` object - record it as an array.
                    const plain = item && typeof item === 'object' && 'callee' in item ? { gtag: Array.from(item) } : item;
                    try {
                        window.__dlRecord(JSON.stringify(plain));
                    } catch (e) {
                        /* ignore */
                    }
                }
                return original.apply(this, items);
            };
            return arr;
        };
        let current;
        Object.defineProperty(window, 'dataLayer', {
            configurable: true,
            get: () => current,
            set: (value) => {
                current = wrap(value);
            },
        });
    });

    const errors = [];
    context.on('page', (p) => watchPage(p, errors));

    return { browser, context, pushes, errors };
}

function watchPage(page, errors) {
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
}

/** Pushes recorded since `mark` (an index into pushes). */
export function since(pushes, mark) {
    return pushes.slice(mark).map((p) => p.data);
}

export function eventsNamed(list, name) {
    return list.filter((d) => d && d.event === name);
}

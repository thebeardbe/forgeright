/**
 * Security headers, set on every response.
 *
 * WHY THIS EXISTS: the app sent none at all. No CSP, no nosniff, no referrer policy, no frame
 * protection, and Express announced its own name in `X-Powered-By`.
 *
 * TWO OF THESE ARE LOAD-BEARING FOR DEFECTS FOUND IN THE SAME REVIEW:
 *
 *   Referrer-Policy: no-referrer. The participant's 90-day token is a PATH SEGMENT of `/q/<token>`,
 *   so the browser would otherwise send it in a `Referer` header to anything the page requests or
 *   links to. `no-referrer` is the strict value for exactly that reason; `strict-origin-when-cross-
 *   origin` would still send the full path on a same-origin request.
 *
 *   Content-Security-Policy. It would also have stopped the stored XSS, which is why the escaping in
 *   lib/json-for-script.js was fixed ON ITS OWN MERITS: a nonce CSP is easy to weaken later, an
 *   escape is not.
 *
 * THE SCRIPTS THAT NEED ALLOWING, and why a nonce rather than moving them to files:
 *
 *   FOUR INLINE BLOCKS, in theme-head (the theme switcher and the analytics loader), audit.ejs (the
 *   page config), admin-roadmap.ejs (the tabs) and cookie-notice.ejs (the banner). Each of them
 *   interpolates server-rendered values (palette ids, the participant token, the strings table), so
 *   moving them to files would mean shipping those values some other way: a data attribute read by a
 *   loader, or a build step. A per-request nonce keeps them where they are and costs one attribute.
 *
 *   `script-src` therefore carries a nonce and NOT `'unsafe-inline'`. Adding `'unsafe-inline'` next
 *   to a nonce would make browsers ignore the nonce entirely and reopen the XSS this is paired with.
 *
 *   THE ANALYTICS SCRIPT IS LOADED AT RUNTIME by `document.createElement`, which a nonce cannot
 *   cover, because the element is created after the policy is in force. Its host is named in
 *   `script-src` instead, and `connect-src` names it too because the script posts its page view
 *   back with fetch/beacon. It stays absent on the participant pages, which opt out in their own
 *   view, so the CSP does not decide which pages are counted.
 *
 *   `style-src` needs `'unsafe-inline'` because views/admin-roadmap.ejs and public/js/audit.js both
 *   set `style` attributes for a progress bar and a muted colour. That is a real weakening, it is
 *   limited to styles, and it is recorded here rather than quietly left out.
 *
 * `base-uri 'none'` and `form-action 'self'` mean an injected `<base>` cannot retarget the page's
 * relative URLs and a form cannot be posted to another origin.
 */
import crypto from 'node:crypto';

/** The counting host, named once so the policy and the loader cannot disagree. */
export const ANALYTICS_HOST = 'https://stats.thebeard.be';

/**
 * A fresh nonce for one response.
 *
 * 16 random bytes, base64. It goes in the CSP header and on each inline `<script>` of that response,
 * so a value injected into the page by an attacker cannot guess or reuse it.
 *
 * @returns {string}
 */
export function newNonce() {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * Build the Content-Security-Policy for one response.
 *
 * @param {string} nonce the value for this response, from `newNonce()`
 * @returns {string} the header value
 */
export function contentSecurityPolicy(nonce) {
    return [
        "default-src 'self'",
        // The nonce covers the four inline blocks; the host covers the runtime-created loader.
        `script-src 'self' 'nonce-${nonce}' ${ANALYTICS_HOST}`,
        // 'unsafe-inline' is required by the style attributes in admin-roadmap.ejs and audit.js.
        "style-src 'self' 'unsafe-inline'",
        // The palettes and fonts are all served locally, so no font host is named.
        "font-src 'self'",
        "img-src 'self' data:",
        // The counting script posts its page view here.
        `connect-src 'self' ${ANALYTICS_HOST}`,
        // A participant page must not be framed, and frame-ancestors says so for CSP-aware browsers
        // while X-Frame-Options covers the rest.
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'"
    ].join('; ');
}

/**
 * Whether a path is private enough to keep out of every cache.
 *
 * `/q` carries a token in its path, and `/admin` is behind a session cookie. A shared cache that
 * stored either would serve one person's page to another.
 *
 * @param {string} pathname
 * @param {string} basePath the app's public path, empty at the root
 * @returns {boolean}
 */
export function isUncacheable(pathname, basePath) {
    const p = basePath ? pathname.slice(basePath.length) || '/' : pathname;
    return p === '/q' || p.startsWith('/q/') || p === '/admin' || p.startsWith('/admin/');
}

/**
 * Install the headers on an Express app.
 *
 * The nonce is generated HERE, before any template renders, so the header and the markup always
 * carry the same value.
 *
 * @param {import('express').Express} app
 * @param {{ publicPath?: string }} [options]
 */
export function applySecurityHeaders(app, { publicPath = '' } = {}) {
    // Express announces itself in every response by default. Nothing depends on the value.
    app.disable('x-powered-by');

    app.use((req, res, next) => {
        const nonce = newNonce();

        // Read by the templates as `<%= cspNonce %>`. On res.locals so every view sees it.
        res.locals.cspNonce = nonce;

        res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
        // The token is in the path, so no referrer at all.
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        // Only meaningful over HTTPS, and harmless over plain HTTP: the browser ignores it there, so
        // a local run over http is not pinned to https.
        res.setHeader('Strict-Transport-Security', 'max-age=31536000');

        if (isUncacheable(req.path, publicPath)) {
            res.setHeader('Cache-Control', 'no-store');
            // A page with a token in its URL must not be kept by the browser's back/forward cache
            // either, so returning to it re-checks that the token is still live.
            res.setHeader('Pragma', 'no-cache');
        }

        next();
    });
}

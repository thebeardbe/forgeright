/**
 * Which peers may be trusted to set the forwarded-protocol headers.
 *
 * WHAT THIS CONTROLS. `req.secure`, `req.protocol` and `req.ip` reflect the
 * `X-Forwarded-*` headers only when Express has been told to trust the peer that
 * sent them. Whether a request counts as secure decides whether the whole site is
 * served or refused (see require-secure.js), so this setting stands between a
 * cleartext request and the application.
 *
 * ADDRESSES, NOT HOP COUNTS, and that distinction is the fix for a real bypass. A
 * hop count says "trust the peer that connects to me". Express evaluates it
 * against the socket, so with a count of 1 ANY peer could send the header and be
 * believed, including one on the LAN. Measured before this change, from the
 * container's LAN address with TRUST_PROXY=1:
 *
 *   Host: <public>, no X-Forwarded-Proto       -> 308 refused (correct)
 *   Host: <public>, X-Forwarded-Proto: https   -> 200 SERVED OVER CLEARTEXT
 *
 * The header was believed because the peer was one hop away, which it always is.
 * An address says "trust only this peer", so a LAN client cannot claim to be the
 * proxy no matter how many hops away it is.
 *
 * THE RESIDUAL RISK, which no setting here removes: trust is decided from the
 * PEER ADDRESS, so anything that can connect from a trusted address is trusted,
 * including another process on this host that reaches 127.0.0.1. That is why the
 * listener is bound to HOST (default 127.0.0.1) as well: the trust setting and the
 * bind address are two halves of one boundary, and either alone is weaker than
 * both. See the HOST handling in server.js.
 */

/** Addresses that mean "this machine", in the forms Node reports for a peer. */
const LOOPBACK_ALIAS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** Words that look like a boolean and would trust every client. Refused. */
const BOOLEAN_LIKE = new Set(['true', 'false', 'on', 'off', 'yes', 'no']);

/**
 * The hostname from a Host header, handling brackets correctly.
 *
 * SPLITTING ON ":" IS WRONG FOR IPv6, and this is the one place that rule lives
 * so two callers cannot disagree. The header "[::1]:3000" and the bare "::1"
 * both break a naive split: the first yields "[", the second yields "", so
 * neither can ever equal "::1" and an IPv6 entry in a host list is unreachable
 * however it is written.
 *
 * `new URL` parses an authority correctly, including brackets, so the bracketed
 * form is returned as "[::1]" and a bare one as "::1"; both are kept because they
 * are genuinely different strings after parsing. A value that does not parse
 * falls back to a plain split, which is right for every ordinary hostname and
 * fails safe for anything strange.
 *
 * @param {string} header The raw Host header.
 * @returns {string} Lowercased hostname, or "" when there is none.
 */
export function hostnameFromHeader(header) {
    const value = String(header || '').trim();
    if (value === '') return '';

    try {
        // A scheme is needed for URL to parse an authority. This is string
        // parsing only: no request is made and no network is touched.
        return new URL(`http://${value}`).hostname.toLowerCase();
    } catch (err) {
        // An unparseable Host is not fatal here: fall back to the plain split so
        // an ordinary name still matches, and anything unusual simply fails the
        // comparison rather than throwing out of middleware.
        return value.split(':')[0].trim().toLowerCase();
    }
}

/**
 * A loose check that a string is an IP address, so a hostname or a typo is
 * refused at startup rather than silently matching nothing.
 *
 * Deliberately permissive about the exact form (IPv4, IPv6, IPv4-mapped): the
 * value is handed to Express, which does the matching, and this only rejects
 * something that is plainly not an address.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isTrustableAddress(value) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
    if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
    // A bare IPv6 address, or an Express CIDR such as "10.0.0.0/8".
    if (/^[0-9a-f:]+(\/\d{1,3})?$/i.test(value) && value.includes(':')) return true;
    return false;
}

/**
 * Resolves TRUST_PROXY into an Express setting plus a sentence for the log.
 *
 * @returns {{ setting: boolean|number|string|string[], summary: string }}
 * @throws {Error} When the value cannot be understood, naming what to use instead.
 */
export function resolveTrustProxy() {
    const raw = process.env.TRUST_PROXY;

    if (raw === undefined || raw.trim() === '') {
        return { setting: false, summary: 'none (TRUST_PROXY unset): forwarded headers are ignored' };
    }

    const value = raw.trim();
    const lower = value.toLowerCase();

    if (lower === 'loopback') {
        return {
            setting: LOOPBACK_ALIAS,
            summary: `loopback only (${LOOPBACK_ALIAS.join(', ')}): only a proxy on this host is trusted`
        };
    }

    if (BOOLEAN_LIKE.has(lower)) {
        throw new Error(
            `TRUST_PROXY=${JSON.stringify(value)} looks like a boolean. A boolean trusts EVERY client, ` +
            'which lets any request claim to be secure. Name the proxy address instead, for example ' +
            'TRUST_PROXY=127.0.0.1, or leave it unset to trust nothing.'
        );
    }

    // A hop count. Accepted for Express compatibility, but named as the weaker
    // form wherever it appears, because it cannot tell a proxy from a client.
    if (/^\d+$/.test(value)) {
        const hops = Number(value);
        if (hops === 0) {
            return { setting: false, summary: 'none (TRUST_PROXY=0): forwarded headers are ignored' };
        }
        console.warn(
            `[server] TRUST_PROXY=${hops} is a HOP COUNT, which trusts the peer that connects to this ` +
            'server regardless of who it is. That is only safe when the port is unreachable except ' +
            'through your proxy. Prefer the proxy address, for example TRUST_PROXY=127.0.0.1.'
        );
        return {
            setting: hops,
            summary: `${hops} hop(s): WEAK FORM, trusts any peer at that distance`
        };
    }

    const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);

    const invalid = entries.filter((entry) => !isTrustableAddress(entry) && entry.toLowerCase() !== 'uniquelocal');
    if (invalid.length > 0) {
        throw new Error(
            `TRUST_PROXY=${JSON.stringify(value)} is not understood. Use an address (127.0.0.1), a ` +
            'comma-separated list of addresses, "loopback", a hop count, or leave it unset to trust ' +
            `nothing. Not understood: ${invalid.join(', ')}.`
        );
    }

    return {
        setting: entries.length === 1 ? entries[0] : entries,
        summary: `${entries.join(', ')}: only these peers may forward the protocol header`
    };
}

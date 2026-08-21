/**
 * @studyzy/dsh-web-remote-access/settings-api — host half of the remote-access
 * settings page. Registers `/api/remote-access/*` routes on the webserver:
 *
 *   GET /api/remote-access/status — bind info, access URLs and a QR code
 *
 * Access is direct (no token gate): these routes are reachable by any browser
 * on the bound interfaces; the webserver presents
 * `/api` requests as loopback so the full UI (including settings) works from
 * a phone/LAN browser.
 */
import z from '@deepseek-ai/schemastery';
import QRCode from 'qrcode';
import { lanAddresses } from './url.js';

/** Stable Cordis plugin name. */
export const name = 'web-remote-settings-api';
/** Services required before the API can register its routes. */
export const inject = ['webServer', 'webStartup'];
export const Config = z.object({});
/** The loopback authority label used when the server binds all interfaces. */
const LOOPBACK_HOST = '127.0.0.1';

/** Write a JSON response. */
function jsonResponse(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

export function apply(ctx, config) {
    const webServer = ctx.webServer;
    const port = webServer.port;
    const bindHost = webServer.host;

    /** The access origins: loopback always, plus each LAN literal for an all-interfaces bind. */
    const accessOrigins = () => {
        const origins = [{ label: '本机 (loopback)', base: `http://${LOOPBACK_HOST}:${String(port)}` }];
        for (const lan of lanAddresses(bindHost))
            origins.push({ label: `局域网 ${lan}`, base: `http://${lan}:${String(port)}` });
        return origins;
    };

    /**
     * Build the status payload: bind info, access URLs (plain, no token — the
     * UI is directly accessible), and an SVG QR code of the primary URL (the
     * first LAN origin when bound to all interfaces, else the loopback
     * origin). Scanning the QR on a phone opens the Web UI directly.
     */
    const statusPayload = async () => {
        const origins = accessOrigins();
        const primary = origins.length > 1 ? origins[1] : origins[0];
        const qrUrl = primary.base;
        const svg = await QRCode.toString(qrUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 320 });
        return {
            port,
            host: bindHost,
            origins,
            qr: {
                url: qrUrl,
                svg: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
            },
        };
    };

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/remote-access/status',
        handler: async (_req, res) => {
            try {
                jsonResponse(res, 200, await statusPayload());
            }
            catch (error) {
                ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
                jsonResponse(res, 500, { ok: false, error: 'internal' });
            }
        },
    }));
}

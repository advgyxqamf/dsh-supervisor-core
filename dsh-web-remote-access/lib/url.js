/**
 * @studyzy/dsh-web-remote-access/url — the web URL line printer. Replaces the stock web-app
 * URL print (which the bundle patch disables) so the printed line mirrors the
 * /api trust snapshot (non-internal IPv4 literals for an all-interfaces bind).
 * The URLs carry no token: access is direct.
 */
import { networkInterfaces } from 'node:os';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export const name = 'web-remote-url';
/** Services required before the URL can be read. */
export const inject = ['webStartup', 'webServer'];
export const Config = z.object({
    printUrl: z.boolean().default(true),
});
/** The loopback host the local URL always prints. */
const LOOPBACK_HOST = '127.0.0.1';
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = '0.0.0.0';
/** LAN IPv4 literals for an all-interfaces bind; empty for a loopback bind. */
export function lanAddresses(bindHost) {
    if (bindHost !== ALL_INTERFACES_HOST)
        return [];
    return Object.values(networkInterfaces()).flat()
        .filter((iface) => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
        .map(iface => iface.address);
}
/**
 * Print the web URL line, waiting for Loader settlement when one exists so a
 * supervisor (or a keyless smoke) can RPC as soon as the line appears. A
 * failed or torn-down boot prints nothing.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
    if (!config.printUrl)
        return;
    const printUrl = () => {
        const server = ctx.get('webServer');
        if (server === undefined)
            return;
        const local = `http://${LOOPBACK_HOST}:${String(server.port)}`;
        const lan = lanAddresses(server.host)[0];
        const lanLine = lan === undefined
            ? ''
            : ` (LAN: http://${lan}:${String(server.port)})`;
        console.log(`dsh web: ${local}${lanLine}`);
    };
    const settled = ctx.get('loader')?.await();
    if (settled === undefined)
        printUrl();
    else {
        void settled.then(() => {
            if (ctx.get('webServer') !== undefined)
                printUrl();
        }, () => { });
    }
}

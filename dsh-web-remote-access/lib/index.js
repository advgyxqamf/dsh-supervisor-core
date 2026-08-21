/**
 * @studyzy/dsh-web-remote-access — out-of-tree dsh web-profile bundle.
 * Subpath plugins (./startup, ./webserver, ./url, ./settings-api) replace or
 * extend the web-app rows they fork; this index entry keeps the package
 * self-describing.
 *
 * The package root is also a loader entry named by the package itself, so
 * `ClientModuleRegistry` (dsh-client-modules) scans this package's
 * `dsh.client` declaration and composes `lib/client.js` (the remote-access
 * settings page) into `window.__DSH_BOOT__`. The node half carries no
 * host-side behavior for that row (mirrors `ui-settings`).
 */
export { WEB_STARTUP_SERVICE } from './startup.js';
export function apply() { }

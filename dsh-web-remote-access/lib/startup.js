/**
 * @studyzy/dsh-web-remote-access/startup — a fork of `@deepseek-ai/dsh-web-app/startup` that
 * parses the `dsh --profile web` flag family (`--host`, `--port`,
 * `--trusted-host`, `--no-open`) and its `--help` text, then provides the
 * immutable values as {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that
 * service before reading it from lazy config.
 *
 * There is deliberately NO access-token logic anywhere: the Web UI is directly
 * accessible on whatever interfaces the server binds. A token gate would
 * intercept the throwaway instances a developer (or a worker) starts on other
 * ports for testing, returning 401 to every unauthenticated request and
 * corrupting the real feedback loop of the project.
 *
 * The flag parse and bounded-exit wiring is a vendored port of
 * `@deepseek-ai/dsh-cmdline`'s `parseCmdline` (MIT). This bundle forks the
 * official startup, and depending on that rc package pulled an unsatisfied
 * `dsh-invariants` peer into every profile install (the harness resolves
 * out-of-tree peers at runtime, but pnpm still warns). Inlining the ~40 lines
 * keeps consumers install-clean and independent of rc churn.
 */
import { Command } from 'commander';
/** Stable Cordis plugin name. */
export const name = 'web-startup';
/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs'];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup';
/** Test hooks: the output streams. */
export const internals = {
    stdout: process.stdout,
    stderr: process.stderr,
};
/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand() {
    return new Command()
        .name('dsh --profile web')
        .description('Serve the DeepSeek Harness browser UI.')
        .helpOption('-h, --help', 'show this help')
        .option('--host <host>', 'bind host')
        .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
        .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
        .option('--no-open', 'do not open the Web UI in the default browser')
        .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port; direct access (no token)
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --host 0.0.0.0           serve on all interfaces, direct access (phone-friendly)
`);
}
/**
 * Whether any command in the tree declares an action handler.
 *
 * The `Command` type cannot express the action precondition, so the handler is
 * read structurally (as {@link isCommanderError} reads commander's control-flow
 * errors): without this guard, a program that forgot its action would parse
 * successfully, publish nothing, and surface only as dependent rows pending on
 * the absent service.
 * @param command - the command whose tree is inspected.
 * @returns true when the command or any registered subcommand has an action.
 */
function hasAction(command) {
    if (typeof command._actionHandler === 'function')
        return true;
    return command.commands.some(hasAction);
}
/**
 * Route every command's exit and output through the launcher adapter.
 *
 * Commander copies `exitOverride` and output configuration into a subcommand
 * only at registration, so a root-only override would let an
 * already-registered subcommand's rejection write to the process streams and
 * call `process.exit` directly, bypassing the launcher's bounded exit.
 * @param command - the root of the command tree to configure.
 */
function configureExitAndOutput(command) {
    command
        .exitOverride()
        .configureOutput({
        writeOut: text => void internals.stdout.write(text),
        writeErr: text => void internals.stderr.write(text),
    });
    for (const child of command.commands)
        configureExitAndOutput(child);
}
/**
 * Whether a thrown value is commander's own control-flow error (help, version,
 * a parse error, or `program.error`).
 *
 * Detected structurally, not with `instanceof`: an out-of-tree plugin brings
 * its own commander copy, whose `CommanderError` class is a different identity
 * from any commander the harness imported, and an identity check there would
 * rethrow a printed help as a fatal load failure.
 * @param error - the thrown value.
 * @returns true when the value carries commander's error code and exit code.
 */
function isCommanderError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    return typeof candidate.code === 'string' && candidate.code.startsWith('commander.')
        && typeof candidate.exitCode === 'number';
}
/**
 * Parse the launcher's immutable argument snapshot with this app's commander
 * program. Commander runs the program's own synchronous action handler on a
 * successful parse; app code there publishes its service and rejects an
 * invalid invocation with `program.error(...)`.
 *
 * Help, version, and rejected arguments — from the grammar or from an action
 * — are terminal for the process: commander writes the text and the helper
 * requests `ctx.appExit`. The action never runs on help, version, or a
 * grammar rejection; an action must reject before it publishes, because
 * statements before its `program.error(...)` have already run.
 * @param ctx - plugin context carrying `cmdlineArgs` and `appExit`.
 * @param program - the app's commander program, with its flags, description,
 * actions, and any subcommands already declared.
 * @throws when the launcher did not provide the command line and exit request,
 * or when no command in the program declares an action.
 */
function parseCmdline(ctx, program) {
    // Read through the global service store, not the property proxy: appExit is
    // an optional host value and the plugin only needs to inject cmdlineArgs.
    const args = ctx.get('cmdlineArgs');
    const exit = ctx.get('appExit');
    if (args === undefined || exit === undefined) {
        throw new Error(`${program.name()}: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts`);
    }
    if (!hasAction(program)) {
        throw new Error(`${program.name()}: no command in the program declares an action; parseCmdline runs the invoked command's action on a successful parse, and app code there publishes its service`);
    }
    configureExitAndOutput(program);
    try {
        program.parse(args.get(), { from: 'user' });
    }
    catch (error) {
        // exitOverride turns help, version, a parse error, and the action's own
        // program.error() into a CommanderError; commander has already written the
        // text through the output configured above.
        if (!isCommanderError(error))
            throw error;
        exit(error.exitCode);
    }
}
/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; a non-numeric
 * `--port` is a usage error, so on rejection (and on `--help`) nothing is
 * provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
    const program = webCommand();
    program.action(() => {
        const options = program.opts();
        if (options.port !== undefined && !/^\d+$/.test(options.port)) {
            program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
        }
        ctx.provide(WEB_STARTUP_SERVICE, {
            openBrowser: options.open,
            ...options.host !== undefined && { host: options.host },
            ...options.port !== undefined && { port: Number(options.port) },
            trustedHosts: options.trustedHost ?? [],
        });
    });
    parseCmdline(ctx, program);
}

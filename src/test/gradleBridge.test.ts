import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GradleBridge } from '../core/GradleBridge';

/**
 * Creates a fake gradlew wrapper in the given directory that sleeps for 30 seconds.
 * This guarantees that cancellation always wins any race against the process exit callback.
 */
const SLEEP_SECONDS = 30;

function createSleepingGradlew(dir: string): void {
    if (process.platform === 'win32') {
        // On Windows: an empty marker file triggers the existsSync check, and
        // cmd.exe finds the .bat via PATHEXT when executing `./gradlew`.
        fs.writeFileSync(path.join(dir, 'gradlew'), '');
        fs.writeFileSync(
            path.join(dir, 'gradlew.bat'),
            `@ping -n ${SLEEP_SECONDS} 127.0.0.1 >nul\r\n`
        );
    } else {
        const script = path.join(dir, 'gradlew');
        fs.writeFileSync(script, `#!/bin/sh\nsleep ${SLEEP_SECONDS}\n`);
        fs.chmodSync(script, '755');
    }
}

suite('GradleBridge', () => {
    let tempDir: string;
    let bridge: GradleBridge;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-bridge-test-'));
        bridge = new GradleBridge(tempDir);
    });

    teardown(() => {
        bridge.dispose();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    suite('runTests', () => {

        test('returns a no-op success result when the filter list is empty', async () => {
            const result = await bridge.runTests([]);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.output, '');
            assert.strictEqual(result.xmlResultsPath, '');
            assert.strictEqual(result.cancelled, undefined);
        });

        test('resolves with cancelled:true when the token is cancelled during execution', async () => {
            createSleepingGradlew(tempDir);

            const cts = new vscode.CancellationTokenSource();
            // Start the run, then synchronously cancel — the cancellation listener fires
            // before any process exit callback because Node.js I/O is always async.
            const resultPromise = bridge.runTests(['com.example.MyTest.myMethod'], cts.token);
            cts.cancel();
            const result = await resultPromise;

            assert.strictEqual(result.cancelled, true);
            assert.strictEqual(result.success, false);
            cts.dispose();
        });

        test('resolves with cancelled:true when an already-cancelled token is passed', async () => {
            createSleepingGradlew(tempDir);

            const cts = new vscode.CancellationTokenSource();
            cts.cancel(); // cancel before calling runTests
            const result = await bridge.runTests(['com.example.MyTest.myMethod'], cts.token);

            assert.strictEqual(result.cancelled, true);
            assert.strictEqual(result.success, false);
            cts.dispose();
        });

        test('includes the correct xmlResultsPath in the cancelled result', async () => {
            createSleepingGradlew(tempDir);
            const expectedPath = path.join(tempDir, 'build', 'test-results', 'test');

            const cts = new vscode.CancellationTokenSource();
            const resultPromise = bridge.runTests(['com.example.MyTest.myMethod'], cts.token);
            cts.cancel();
            const result = await resultPromise;

            assert.strictEqual(result.xmlResultsPath, expectedPath);
            cts.dispose();
        });

        test('resolves normally (not cancelled) when no token is provided', async () => {
            // Empty list → no process spawned, so this resolves immediately.
            const result = await bridge.runTests([]);

            assert.strictEqual(result.cancelled, undefined);
        });
    });

    suite('runAllTests', () => {

        test('resolves with cancelled:true when the token is cancelled during execution', async () => {
            createSleepingGradlew(tempDir);

            const cts = new vscode.CancellationTokenSource();
            const resultPromise = bridge.runAllTests(cts.token);
            cts.cancel();
            const result = await resultPromise;

            assert.strictEqual(result.cancelled, true);
            assert.strictEqual(result.success, false);
            cts.dispose();
        });
    });

    suite('runTest', () => {

        test('resolves with cancelled:true when the token is cancelled during execution', async () => {
            createSleepingGradlew(tempDir);

            const cts = new vscode.CancellationTokenSource();
            const resultPromise = bridge.runTest('com.example.MyTest.myMethod', cts.token);
            cts.cancel();
            const result = await resultPromise;

            assert.strictEqual(result.cancelled, true);
            assert.strictEqual(result.success, false);
            cts.dispose();
        });
    });
});

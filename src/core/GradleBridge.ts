import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as nodeProcess from 'process';

/**
 * Result returned by all Gradle execution methods.
 */
export interface GradleTestResult {
    /** `true` if Gradle exited with code 0 (no build or test failures). */
    success: boolean;
    /** The complete stdout captured from the Gradle process. */
    output: string;
    /** Absolute path to the directory containing JUnit XML result files. */
    xmlResultsPath: string;
}

/**
 * Executes Gradle test commands in the workspace and streams output to a dedicated
 * VS Code `OutputChannel`.
 *
 * Gradle commands are run via `child_process.exec` with the workspace root as the
 * working directory. The Gradle wrapper (`./gradlew`) is preferred over a globally
 * installed `gradle` binary.
 *
 * The XML results directory is always resolved to the standard Gradle output path:
 * `{workspaceRoot}/build/test-results/test`.
 */
export class GradleBridge {

    private readonly workspaceRoot: string;

    /** VS Code output channel used to display Gradle command output. */
    private outputChannel: vscode.OutputChannel;

    /**
     * Creates a new `GradleBridge` for the given workspace.
     *
     * @param workspaceRoot - Absolute path to the workspace root directory.
     */
    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = vscode.window.createOutputChannel(
            'Kotlin Test Runner'
        );
    }

    /**
     * Runs a single test identified by its fully-qualified name.
     *
     * Executes: `./gradlew test --rerun --tests "{fullyQualifiedName}"`
     *
     * @param fullyQualifiedName - Fully-qualified test filter, e.g. `"com.example.MyTest.myMethod"`.
     * @returns A promise resolving to the Gradle execution result.
     */
    async runTest(fullyQualifiedName: string): Promise<GradleTestResult> {
        return this.executeGradle(`test --rerun --tests "${fullyQualifiedName}"`);
    }

    /**
     * Runs multiple tests in a single Gradle invocation using `--tests` filters.
     *
     * Executes: `./gradlew test --rerun --tests "A" --tests "B" ...`
     *
     * Returns a successful no-op result immediately if the list is empty.
     *
     * @param fullyQualifiedNames - Array of fully-qualified test filter strings.
     * @returns A promise resolving to the Gradle execution result.
     */
    async runTests(fullyQualifiedNames: string[]): Promise<GradleTestResult> {
        if (fullyQualifiedNames.length === 0) {
            return { success: true, output: '', xmlResultsPath: '' };
        }

        const filters = fullyQualifiedNames
            .map(name => `--tests "${name}"`)
            .join(' ');

        return this.executeGradle(`test --rerun ${filters}`);
    }

    /**
     * Runs the full test suite by executing `./gradlew cleanTest test`.
     *
     * The `cleanTest` task removes the previous test results, ensuring all tests
     * are re-executed regardless of Gradle's up-to-date checks.
     *
     * @returns A promise resolving to the Gradle execution result.
     */
    async runAllTests(): Promise<GradleTestResult> {
        return this.executeGradle('cleanTest test');
    }

    /**
     * Executes a Gradle command with the given argument string.
     *
     * Clears and shows the output channel before execution, then appends the
     * command header, stdout, and stderr to it.
     *
     * The XML results path is always set to `{workspaceRoot}/build/test-results/test`,
     * regardless of which specific tests were executed.
     *
     * @param args - Gradle arguments appended after the `gradlew` / `gradle` binary name.
     * @returns A promise resolving to the execution result.
     */
    private executeGradle(args: string): Promise<GradleTestResult> {
        return new Promise((resolve, reject) => {
            const gradleCmd = this.getGradleCommand();
            const command = `${gradleCmd} ${args}`;

            this.outputChannel.clear();
            this.outputChannel.show(true);
            this.outputChannel.appendLine(`▶ Running: ${command}`);
            this.outputChannel.appendLine('─'.repeat(60));

            const childProcess = cp.exec(
                command,
                {
                    cwd: this.workspaceRoot,
                    env: { ...nodeProcess.env }
                },
                (error, stdout, stderr) => {
                    this.outputChannel.appendLine(stdout);
                    if (stderr) {
                        this.outputChannel.appendLine(stderr);
                    }

                    const xmlResultsPath = path.join(
                        this.workspaceRoot,
                        'build',
                        'test-results',
                        'test'
                    );

                    resolve({
                        success: error === null,
                        output: stdout,
                        xmlResultsPath
                    });
                }
            );

            childProcess.stdout?.on('data', (data) => {
                this.outputChannel.append(data);
            });
        });
    }

    /**
     * Determines the Gradle executable to use.
     *
     * Returns `./gradlew` if a Gradle wrapper script is present in the workspace root,
     * otherwise falls back to `gradle`, which must be available on `PATH`.
     *
     * @returns The Gradle command string.
     */
    private getGradleCommand(): string {
        const gradlew = path.join(this.workspaceRoot, 'gradlew');
        return fs.existsSync(gradlew) ? './gradlew' : 'gradle';
    }

    /**
     * Disposes the VS Code output channel.
     * Should be called when the extension is deactivated.
     */
    dispose() {
        this.outputChannel.dispose();
    }
}

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as nodeProcess from 'process';

export interface GradleTestResult {
    success: boolean;
    output: string;
    xmlResultsPath: string;
}

export class GradleBridge {

    private readonly workspaceRoot: string;
    private outputChannel: vscode.OutputChannel;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = vscode.window.createOutputChannel(
            'Kotlin Test Runner'
        );
    }

    async runTest(fullyQualifiedName: string): Promise<GradleTestResult> {
        return this.executeGradle(`test --rerun --tests "${fullyQualifiedName}"`);
    }

    async runTests(fullyQualifiedNames: string[]): Promise<GradleTestResult> {
        if (fullyQualifiedNames.length === 0) {
            return { success: true, output: '', xmlResultsPath: '' };
        }

        const filters = fullyQualifiedNames
            .map(name => `--tests "${name}"`)
            .join(' ');

        return this.executeGradle(`test --rerun ${filters}`);
    }

    async runAllTests(): Promise<GradleTestResult> {
        return this.executeGradle('cleanTest test');
    }

    private executeGradle(args: string): Promise<GradleTestResult> {
        return new Promise((resolve, reject) => {
            const gradleCmd = this.getGradleCommand();
            const command = `${gradleCmd} ${args}`;

            this.outputChannel.clear();
            this.outputChannel.show(true);
            this.outputChannel.appendLine(`▶ Ausführen: ${command}`);
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

    private getGradleCommand(): string {
        const gradlew = path.join(this.workspaceRoot, 'gradlew');
        return fs.existsSync(gradlew) ? './gradlew' : 'gradle';
    }

    dispose() {
        this.outputChannel.dispose();
    }
}
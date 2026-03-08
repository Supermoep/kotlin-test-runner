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
        // OutputChannel ist das Terminal-Panel in VSCode
        // Paradigma: Dependency auf VSCode UI wird hier gekapselt
        this.outputChannel = vscode.window.createOutputChannel(
            'Kotlin Test Runner'
        );
    }

    /**
     * Führt einen einzelnen Test aus.
     * 
     * Paradigma: Promise-basierte Asynchronität.
     * In C++ würdest du einen Thread starten und auf Join warten.
     * Hier übergeben wir eine Callback-Funktion (resolve/reject)
     * die aufgerufen wird wenn der Prozess fertig ist.
     */
    async runTest(fullyQualifiedName: string): Promise<GradleTestResult> {
        const filter = this.buildTestFilter(fullyQualifiedName);
        return this.executeGradle(`test --tests "${filter}"`);
    }

    /**
     * Führt alle Tests einer Klasse aus.
     */
    async runTestClass(fullyQualifiedClassName: string): Promise<GradleTestResult> {
        return this.executeGradle(`test --tests "${fullyQualifiedClassName}.*"`);
    }

    /**
     * Führt alle Tests aus.
     */
    async runAllTests(): Promise<GradleTestResult> {
        return this.executeGradle('cleanTest test');
    }

    /**
     * Baut den Gradle Test Filter für eine einzelne Testmethode.
     * Kotlin Backtick-Namen werden korrekt escaped.
     */
    private buildTestFilter(fullyQualifiedName: string): string {
        // Format: com.automotive.sample.SensorDataProcessorTest.methodName
        // Leerzeichen in Backtick-Namen bleiben erhalten für Gradle
        return fullyQualifiedName;
    }

    /**
     * Kernmethode: Führt Gradle als Child-Prozess aus.
     * 
     * Paradigma: Child Process = externes Programm starten.
     * Vergleichbar mit system() oder exec() in C++, aber
     * non-blocking durch Promises.
     */
   private executeGradle(args: string): Promise<GradleTestResult> {
    return new Promise((resolve, reject) => {
        const gradleCmd = this.getGradleCommand();
        const command = `${gradleCmd} ${args}`;

        this.outputChannel.clear();
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`▶ Ausführen: ${command}`);
        this.outputChannel.appendLine('─'.repeat(60));

        // Umbenennung: process → childProcess (Namenskollision vermeiden)
        const childProcess = cp.exec(
            command,
            {
                cwd: this.workspaceRoot,
                env: { ...nodeProcess.env }  // nodeProcess statt process
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

        // Umbenennung: process → childProcess
        childProcess.stdout?.on('data', (data) => {
            this.outputChannel.append(data);
        });
    });
}

    /**
     * Prüft ob ein Gradle Wrapper vorhanden ist.
     * Paradigma: Convention over Configuration –
     * gradlew ist der Standard in Gradle Projekten.
     */
    private getGradleCommand(): string {
        const gradlew = path.join(this.workspaceRoot, 'gradlew');
        const fs = require('fs');
        return fs.existsSync(gradlew) ? './gradlew' : 'gradle';
    }

    dispose() {
        this.outputChannel.dispose();
    }
}
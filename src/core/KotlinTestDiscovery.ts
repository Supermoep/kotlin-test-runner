import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface TestMethod {
    name: string;
    displayName: string;
    hasDisplayName: boolean;
    line: number;
}

export interface TestClass {
    name: string;
    packageName: string;
    fullyQualifiedName: string;
    filePath: string;
    methods: TestMethod[];
}

export class KotlinTestDiscovery {

    private static readonly TEST_ANNOTATION = /@Test/;
    private static readonly DISPLAY_NAME_ANNOTATION = /@DisplayName\("(.+)"\)/;
    private static readonly CLASS_PATTERN = /^class\s+(\w+)/m;
    private static readonly PACKAGE_PATTERN = /^package\s+([\w.]+)/m;
    private static readonly FUN_PATTERN = /fun\s+`?([^`(]+)`?\s*\(/;

    async discoverTests(workspaceRoot: string): Promise<TestClass[]> {
        const testClasses: TestClass[] = [];
        const kotlinFiles = await this.findKotlinTestFiles(workspaceRoot);

        for (const filePath of kotlinFiles) {
            const testClass = await this.parseKotlinFile(filePath);
            if (testClass && testClass.methods.length > 0) {
                testClasses.push(testClass);
            }
        }

        return testClasses;
    }

    private async findKotlinTestFiles(workspaceRoot: string): Promise<string[]> {
        const testSourceDir = path.join(workspaceRoot, 'src', 'test', 'kotlin');

        if (!fs.existsSync(testSourceDir)) {
            vscode.window.showWarningMessage(
                `Kein Test-Verzeichnis gefunden: ${testSourceDir}`
            );
            return [];
        }

        return this.walkDirectory(testSourceDir, '.kt');
    }

    private walkDirectory(dir: string, extension: string): string[] {
        const results: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...this.walkDirectory(fullPath, extension));
            } else if (entry.name.endsWith(extension)) {
                results.push(fullPath);
            }
        }

        return results;
    }

    async parseKotlinFile(filePath: string): Promise<TestClass | null> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        const packageMatch = content.match(KotlinTestDiscovery.PACKAGE_PATTERN);
        const classMatch = content.match(KotlinTestDiscovery.CLASS_PATTERN);

        if (!classMatch) {
            return null;
        }

        const packageName = packageMatch ? packageMatch[1] : '';
        const className = classMatch[1];
        const fullyQualifiedName = packageName
            ? `${packageName}.${className}`
            : className;

        const methods = this.extractTestMethods(lines);

        return {
            name: className,
            packageName,
            fullyQualifiedName,
            filePath,
            methods
        };
    }

    private extractTestMethods(lines: string[]): TestMethod[] {
        const methods: TestMethod[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (!KotlinTestDiscovery.TEST_ANNOTATION.test(lines[i])) {
                continue;
            }

            // @DisplayName in Fenster von 3 Zeilen vor UND nach @Test suchen
            let displayName = '';
            const searchRange = [
                ...Array.from({length: 3}, (_, k) => i - 3 + k),
                ...Array.from({length: 3}, (_, k) => i + 1 + k)
            ];

            for (const k of searchRange) {
                if (k < 0 || k >= lines.length) { continue; }
                const match = lines[k]?.match(
                    KotlinTestDiscovery.DISPLAY_NAME_ANNOTATION
                );
                if (match) {
                    displayName = match[1];
                    break;
                }
            }

            // Funktionsname in den nächsten 4 Zeilen suchen
            for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const funMatch = lines[j].match(KotlinTestDiscovery.FUN_PATTERN);
                if (funMatch) {
                    const name = funMatch[1].trim();
                    methods.push({
                        name,
                        displayName: displayName || name,
                        hasDisplayName: displayName !== '',
                        line: j
                    });
                    break;
                }
            }
        }

        return methods;
    }
}